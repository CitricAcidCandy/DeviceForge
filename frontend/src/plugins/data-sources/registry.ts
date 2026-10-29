import { HostError } from '../../plugin-sdk/models.ts';
import type { Dispose, HostResult, JsonValue } from '../../plugin-sdk/models.ts';
import type { DataAccess, DataSnapshot, DataSourceDefinition, DataSourceInfo, DataSourceRef, DataWrite } from '../../plugin-sdk/data-sources.ts';
import type { ServiceRef } from '../../plugin-sdk/services.ts';
import { isJsonValue } from '../../plugin-sdk/json.ts';
import { compileServiceSchema } from '../extensions/service-schema.ts';
import { revision, snapshot, validateDefinition, validateRef } from './rules.ts';
import { awaitDataCall } from './call.ts';

export interface DataSourceOwner {
  readonly pluginId: string;
  readonly generation: number;
  readonly signal: AbortSignal;
}
export interface DataSourceServices {
  call(ref: ServiceRef, input: JsonValue, signal: AbortSignal): Promise<HostResult<JsonValue>>;
}
interface Registered {
  readonly definition: DataSourceInfo;
  readonly signal: AbortSignal;
  readonly validator: ReturnType<typeof compileServiceSchema>;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** 数据目录只做发现、契约和所有权检查；执行仍走现有服务调用。 */
export function createDataSourceRegistry() {
  const entries = new Map<string, Registered>();
  const listeners = new Set<() => void>();
  const releases = new Set<Dispose>();
  const lifetime = new AbortController();
  let cached: readonly DataSourceInfo[] | null = null;
  function current(signal?: AbortSignal) {
    if (lifetime.signal.aborted || signal?.aborted)
      throw new HostError('cancelled', 'data_source_revoked', '数据源所属插件或运行环境已撤销');
  }
  function notify() {
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* 观察者异常不阻止其他观察者或登记撤销。 */ }
    }
  }
  function invalidate() { cached = null; notify(); }
  function resolve(ref: DataSourceRef): Registered {
    current();
    validateRef(ref);
    const entry = entries.get(ref.id);
    if (!entry || entry.signal.aborted || entry.definition.version !== ref.version)
      throw new HostError('protocol', 'data_source_unavailable', '数据源或请求的精确版本当前不可用');
    return entry;
  }
  function catalog(): readonly DataSourceInfo[] {
    current();
    cached ??= Object.freeze([...entries.values()].map((entry) => entry.definition)
      .sort((left, right) => left.id.localeCompare(right.id)));
    return cached;
  }
  function access(owner: DataSourceOwner, services: DataSourceServices, track: (dispose: Dispose) => Dispose): DataAccess {
    function available() { current(owner.signal); }
    async function invoke(ref: DataSourceRef, input: DataWrite | null, caller: AbortSignal): Promise<HostResult<DataSnapshot>> {
      available();
      const entry = resolve(ref);
      const definition = entry.definition;
      const signal = AbortSignal.any([caller, owner.signal, entry.signal, lifetime.signal]);
      if (signal.aborted) throw new HostError('cancelled', 'cancelled', '数据请求等待已取消');
      if (input !== null) {
        if (definition.readOnly || !definition.write)
          throw new HostError('protocol', 'data_source_read_only', '当前数据源只允许读取');
        if (!revision(input.expectedRevision) || !isJsonValue(input.value))
          throw new HostError('protocol', 'invalid_data_write', '修改必须携带 JSON 值和读取时的修订');
        if (entry.validator && !entry.validator(input.value))
          throw new HostError('protocol', 'data_source_input_invalid', '修改内容不符合数据模式');
      }
      const service = input === null ? definition.read : definition.write;
      if (!service) throw new HostError('protocol', 'data_source_read_only', '当前数据源只允许读取');
      const value: JsonValue = input === null ? {} : { value: structuredClone(input.value), expectedRevision: input.expectedRevision };
      // 透传冲突、结果未知等原错误；绝不自动重放变更操作。
      const result = await awaitDataCall(signal, () => services.call(service, value, signal));
      if (signal.aborted || entries.get(ref.id) !== entry)
        throw new HostError('cancelled', 'stale_data_result', '数据源已更新，本次旧结果不可用于当前编辑', result.logId);
      const data = snapshot(result.data, result.logId);
      if (entry.validator && !entry.validator(data.value))
        throw new HostError('protocol', 'data_source_output_invalid', '数据服务输出不符合数据模式', result.logId);
      if (input !== null) notify();
      return { data, logId: result.logId };
    }
    return Object.freeze<DataAccess>({
      register(definition) {
        available();
        validateDefinition(owner.pluginId, definition);
        if (entries.has(definition.id))
          throw new HostError('protocol', 'data_source_duplicate', '数据源标识已登记');
        const info = freeze<DataSourceInfo>({
          ...structuredClone(definition),
          provider: { pluginId: owner.pluginId, generation: owner.generation },
        });
        const registration = new AbortController();
        const entry: Registered = {
          definition: info,
          signal: AbortSignal.any([owner.signal, registration.signal]),
          validator: compileServiceSchema(info.schema),
        };
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          registration.abort();
          owner.signal.removeEventListener('abort', release);
          releases.delete(release);
          if (entries.get(info.id) !== entry) return;
          entries.delete(info.id);
          invalidate();
        };
        entries.set(info.id, entry);
        releases.add(release);
        owner.signal.addEventListener('abort', release, { once: true });
        if (owner.signal.aborted) release(); else invalidate();
        return track(release);
      },
      catalog() { available(); return catalog(); },
      read: (ref, signal) => invoke(ref, null, signal),
      write: (ref, input, signal) => invoke(ref, input, signal),
      subscribe(listener) {
        available();
        const scoped = () => { if (!owner.signal.aborted) listener(); };
        listeners.add(scoped);
        const release = () => { listeners.delete(scoped); owner.signal.removeEventListener('abort', release); };
        owner.signal.addEventListener('abort', release, { once: true });
        return track(release);
      },
    });
  }
  return {
    access,
    catalog,
    dispose() {
      if (lifetime.signal.aborted) return;
      lifetime.abort();
      for (const release of [...releases]) void release();
      entries.clear(); cached = null; listeners.clear();
    },
  };
}
