import { HostError } from '../../plugin-sdk/models.ts';
import type { DataAccess, DataSourceInfo, DataSnapshot, Dispose, HostResult, JsonValue } from '../../plugin-sdk/index.ts';
import type { DebugDataSourceInfo, DebugDataWrite } from '../../plugin-sdk/debug.ts';
import { copyDataJson, hasSecretData, hasSecretSchema, publicDataSchema, redactDataValue } from '../../plugins/debugger/data-json.ts';
import { changedReadonlyData } from '../../plugins/debugger/data-schema.ts';
import { redactText } from '../../plugins/debugger/privacy.ts';
import { compileServiceSchema } from '../../plugins/extensions/service-schema.ts';
import { bounded, fail } from './validation.ts';

export interface UnifiedDataSourceInfo extends Omit<DebugDataSourceInfo, 'persistence'> {
  readonly persistence: 'memory' | 'persistent' | null;
  readonly persistence_known: boolean;
  readonly origin: 'public-data-source';
  readonly source_ref: { readonly id: string; readonly version: string };
}
interface Binding {
  readonly definition: DataSourceInfo;
  readonly info: UnifiedDataSourceInfo;
  readonly revisions: Map<string, string>;
  readonly registration: string;
  readonly validate: ReturnType<typeof compileServiceSchema>;
  sequence: number;
  writing: boolean;
}

/** 只适配已有公开数据服务；复用原调试敏感字段、只读和修订保护，不增加执行器。 */
export function createUnifiedDebugData(
  pluginId: string,
  generation: string,
  data: DataAccess | undefined,
  lifetime: AbortSignal,
) {
  const bindings = new Map<string, Binding>();
  const sourceBindings = new Map<string, Binding>();
  const current = () => {
    if (lifetime.aborted) fail('stale_generation', '数据源所属插件代次已撤销');
  };
  function sync() {
    current();
    const catalog = data?.catalog().filter((source) =>
      source.provider.pluginId === pluginId && String(source.provider.generation) === generation) ?? [];
    const active = new Set(catalog);
    for (const [id, binding] of bindings) {
      if (active.has(binding.definition)) continue;
      bindings.delete(id); sourceBindings.delete(binding.definition.id);
    }
    for (const source of catalog) {
      if (sourceBindings.get(source.id)?.definition === source) continue;
      // 旧调试协议只接受128字符标识和修订；令牌映射不截断真实公开身份。
      const registration = crypto.randomUUID();
      const id = `unified.${registration}`;
      const schema = source.schema ?? true;
      const info: UnifiedDataSourceInfo = {
        id, label: redactText(source.title), ...publicDataSchema(schema),
        writable: !source.readOnly && !!source.write && !hasSecretSchema(schema),
        persistence: source.persistence ?? null, persistence_known: source.persistence !== undefined,
        apply_policy: source.applyPolicy, origin: 'public-data-source',
        source_ref: { id: source.id, version: source.version },
      };
      const binding: Binding = { definition: source, info, registration, validate: compileServiceSchema(source.schema),
        revisions: new Map(), sequence: 0, writing: false };
      bindings.set(id, binding); sourceBindings.set(source.id, binding);
    }
  }
  function binding(id: string): Binding {
    sync();
    const result = bindings.get(id);
    if (!result) return fail('data_source_unavailable', '当前插件及代次没有此公开数据源');
    return result;
  }
  function publish(source: Binding, result: DataSnapshot) {
    for (const [token, raw] of source.revisions) {
      if (raw === result.revision) return { revision: token, value: redactDataValue(source.definition.schema ?? true, copyDataJson(result.value)) };
    }
    const token = `${source.registration}.${++source.sequence}`;
    source.revisions.set(token, result.revision);
    if (source.revisions.size > 32) {
      const oldest = source.revisions.keys().next().value;
      if (oldest) source.revisions.delete(oldest);
    }
    return { revision: token, value: redactDataValue(source.definition.schema ?? true, copyDataJson(result.value)) };
  }
  async function read(source: Binding, signal: AbortSignal) {
    if (!data) return fail('data_source_unavailable', '当前宿主未装配公开数据目录');
    const result = await data.read(source.definition, signal);
    signal.throwIfAborted(); sync();
    if (bindings.get(source.info.id) !== source) return fail('stale_generation', '数据源登记已变化，请重新读取');
    return result;
  }
  const unsubscribe: Dispose | undefined = data?.subscribe(() => {
    if (!lifetime.aborted) sync();
  });
  const dispose = () => { void unsubscribe?.(); bindings.clear(); sourceBindings.clear(); };
  lifetime.addEventListener('abort', dispose, { once: true });
  return {
    catalog(): readonly UnifiedDataSourceInfo[] { sync(); return [...bindings.values()].map((source) => source.info); },
    has(id: string) { sync(); return bindings.has(id); },
    async read(id: string, query: JsonValue, caller: AbortSignal) {
      if (query !== null && (typeof query !== 'object' || Array.isArray(query) || Object.keys(query).length))
        return fail('invalid_parameters', '公开数据源不声明查询参数，query只能为null或空对象');
      const source = binding(id);
      const signal = AbortSignal.any([caller, lifetime, AbortSignal.timeout(10000)]);
      return bounded(async () => {
        const result = await read(source, signal);
        return { ...publish(source, result.data), logId: result.logId };
      }, signal, false);
    },
    async write(id: string, request: DebugDataWrite, caller: AbortSignal) {
      const source = binding(id);
      if (!data || source.definition.readOnly || !source.definition.write) return fail('data_read_only', '此公开数据源只读');
      const schema = source.definition.schema ?? true;
      if (hasSecretSchema(schema) || hasSecretData(request.value))
        return fail('sensitive_data_write', '含敏感字段的数据不能通过调试器整体替换');
      if (source.writing) return fail('data_source_busy', '此公开数据源已有写入等待，不隐式排队或重放');
      const expectedRevision = source.revisions.get(request.expectedRevision);
      if (expectedRevision === undefined) return fail('revision_conflict', '修订不属于当前公开数据源，请重新读取后修改');
      const value = copyDataJson(request.value);
      if (source.validate && !source.validate(value)) return fail('invalid_data', '待写入数据不符合数据源模式');
      const signal = AbortSignal.any([caller, lifetime, AbortSignal.timeout(10000)]);
      source.writing = true;
      let started = false;
      try {
        return await bounded(async () => {
          const before = await read(source, signal);
          if (before.data.revision !== expectedRevision) return fail('revision_conflict', '数据已变更，请保留草稿并重新读取');
          if (hasSecretData(before.data.value)) return fail('sensitive_data_write', '现有数据包含敏感字段，请提供无敏感业务投影');
          if (changedReadonlyData(schema, before.data.value, value)) return fail('data_read_only', '不能修改声明为只读的业务字段');
          let result: HostResult<DataSnapshot>;
          started = true;
          try { result = await data.write(source.definition, { expectedRevision, value }, signal); }
          catch (error) {
            if (error instanceof HostError && ['revision_conflict', 'debugger_revision_conflict'].includes(error.code))
              throw new HostError('protocol', 'debugger_revision_conflict', '数据在写入前已变更，请保留草稿并重新读取', error.logId);
            throw new HostError(error instanceof HostError ? error.kind : 'protocol', 'debugger_result_unconfirmed',
              '公开数据写入结果未确认，请重新读取实际状态；不会自动重放', error instanceof HostError ? error.logId : null);
          }
          signal.throwIfAborted(); sync();
          if (bindings.get(source.info.id) !== source) return fail('result_unconfirmed', '写入回执属于已撤销的数据源，请查询实际状态');
          return { ...publish(source, result.data), logId: result.logId };
        }, signal, false);
      } catch (error) {
        if (started && signal.aborted)
          throw new HostError(caller.aborted ? 'cancelled' : 'protocol', 'debugger_result_unconfirmed',
            '公开数据写入结果未确认，请重新读取实际状态；不会自动重放', error instanceof HostError ? error.logId : null);
        throw error;
      } finally { source.writing = false; }
    },
    dispose() { lifetime.removeEventListener('abort', dispose); dispose(); },
  };
}
export type UnifiedDebugData = ReturnType<typeof createUnifiedDebugData>;
