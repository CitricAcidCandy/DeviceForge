import { Ajv } from 'ajv';
import type { ValidateFunction } from 'ajv';
import { HostError } from '../../plugin-sdk/models.ts';
import type { Dispose, JsonValue } from '../../plugin-sdk/models.ts';
import type { DebugDataSnapshot, DebugDataSourceDefinition, DebugDataSourceInfo, DebugDataWrite } from '../../plugin-sdk/debug.ts';
import { changedReadonlyData } from './data-schema.ts';
import { copyDataJson, dataError, hasSecretData, hasSecretSchema, publicDataSchema, redactDataValue } from './data-json.ts';
import { freezeJson, text } from './json.ts';
import { redactText } from './privacy.ts';

interface DataEntry {
  readonly definition: DebugDataSourceDefinition;
  readonly info: DebugDataSourceInfo;
  readonly validate: ValidateFunction;
  readonly lifetime: AbortController;
  readonly registration: string;
  readonly revisions: Map<string, string>;
  revisionSequence: number;
  writing: boolean;
}
export interface DebugDataSources {
  readonly register: (definition: DebugDataSourceDefinition) => Dispose;
  readonly catalog: () => readonly DebugDataSourceInfo[];
  readonly read: (id: string, query: JsonValue, signal: AbortSignal) => Promise<DebugDataSnapshot>;
  readonly write: (id: string, request: DebugDataWrite, signal: AbortSignal) => Promise<DebugDataSnapshot>;
  readonly dispose: () => void;
}

export function createDebugDataSources(signal: AbortSignal, changed: () => void): DebugDataSources {
  const sources = new Map<string, DataEntry>();
  let closed = false;
  function current() {
    if (closed || signal.aborted) dataError('stale_generation', '数据源所属插件代次已撤销');
  }
  function entry(id: string): DataEntry {
    current();
    const result = sources.get(id);
    if (!result) return dataError('data_source_unavailable', '当前插件没有登记此数据源');
    return result;
  }
  async function run<T>(source: DataEntry, caller: AbortSignal, operation: (combined: AbortSignal, startingWrite: () => void) => Promise<T>): Promise<T> {
    current(); caller.throwIfAborted();
    const deadline = new AbortController();
    const combined = AbortSignal.any([signal, source.lifetime.signal, caller, deadline.signal]);
    let mutation = false;
    const timer = setTimeout(() => deadline.abort(), 10000);
    try {
      return await new Promise<T>((resolve, reject) => {
        const cancel = () => {
          combined.removeEventListener('abort', cancel);
          reject(new HostError(caller.aborted ? 'cancelled' : 'protocol',
            mutation ? 'debugger_result_unconfirmed' : 'debugger_data_cancelled',
            mutation ? '数据写入结果未确认，请重新读取实际状态；不会自动重放' : '数据读取已取消、到期或所属代次已撤销'));
        };
        combined.addEventListener('abort', cancel, { once: true });
        if (combined.aborted) { cancel(); combined.removeEventListener('abort', cancel); return; }
        Promise.resolve().then(() => {
          combined.throwIfAborted();
          return operation(combined, () => { combined.throwIfAborted(); mutation = true; });
        }).then(resolve, reject).finally(() => combined.removeEventListener('abort', cancel));
      });
    } finally { clearTimeout(timer); }
  }
  async function snapshot(source: DataEntry, query: JsonValue, combined: AbortSignal): Promise<DebugDataSnapshot> {
    let result: unknown;
    try { result = await source.definition.read(query, combined); }
    catch { return dataError('data_read_failed', '插件数据读取失败，请查询对应插件日志'); }
    combined.throwIfAborted();
    const copied = copyDataJson(result, false, 1024 * 1024);
    if (!copied || typeof copied !== 'object' || Array.isArray(copied) || typeof copied['revision'] !== 'string' || copied['value'] === undefined)
      return dataError('invalid_data', '数据源必须返回修订和JSON数据');
    text(copied['revision'], '数据修订', 128);
    const value = copyDataJson(copied['value']);
    if (!source.validate(value)) return dataError('invalid_data', '数据源返回值不符合声明模式');
    return { revision: copied['revision'], value };
  }
  function publicRevision(source: DataEntry, revision: string): string {
    for (const [published, raw] of source.revisions) if (raw === revision) return published;
    const published = `${source.registration}.${++source.revisionSequence}`;
    source.revisions.set(published, revision);
    if (source.revisions.size > 32) {
      const oldest = source.revisions.keys().next().value;
      if (oldest !== undefined) source.revisions.delete(oldest);
    }
    return published;
  }
  function dispose() {
    if (closed) return;
    closed = true;
    signal.removeEventListener('abort', dispose);
    for (const source of sources.values()) source.lifetime.abort();
    sources.clear();
  }
  signal.addEventListener('abort', dispose, { once: true });
  if (signal.aborted) dispose();
  return {
    register(input) {
      current();
      text(input.id, '数据源标识', 128); text(input.label, '数据源名称', 128);
      if (!['memory', 'persistent'].includes(input.persistence) || !['immediate', 'next_invocation', 'reload'].includes(input.applyPolicy) ||
        typeof input.read !== 'function' || (input.write !== undefined && typeof input.write !== 'function'))
        return dataError('invalid_data', '数据源读写回调、持久性或生效策略无效');
      if (sources.has(input.id) || sources.size >= 64) return dataError('data_source_conflict', '数据源标识重复或已达64项上限');
      const schema = freezeJson(copyDataJson(input.schema));
      if (typeof schema !== 'boolean' && (!schema || typeof schema !== 'object' || Array.isArray(schema)))
        return dataError('invalid_schema', '数据源模式必须为对象或布尔值');
      let validate: ValidateFunction;
      try { validate = new Ajv({ strict: false, allErrors: false, validateFormats: false }).compile(schema); }
      catch { return dataError('invalid_schema', '数据源模式无法编译'); }
      const source: DataEntry = {
        definition: { id: input.id, label: input.label, schema, persistence: input.persistence, applyPolicy: input.applyPolicy,
          read: input.read, ...(input.write ? { write: input.write } : {}) },
        info: freezeJson({ id: input.id, label: redactText(input.label), ...publicDataSchema(schema), writable: !!input.write && !hasSecretSchema(schema),
          persistence: input.persistence, apply_policy: input.applyPolicy }),
        validate, lifetime: new AbortController(), registration: crypto.randomUUID(), revisions: new Map(), revisionSequence: 0, writing: false,
      };
      copyDataJson([...sources.values()].map(item => item.info).concat(source.info), false, 1024 * 1024);
      sources.set(input.id, source); changed();
      return () => {
        source.lifetime.abort();
        if (sources.get(source.definition.id) === source) { sources.delete(source.definition.id); changed(); }
      };
    },
    catalog() { current(); return [...sources.values()].map(source => source.info); },
    async read(id, query, caller) {
      const source = entry(id);
      const input = copyDataJson(query);
      return run(source, caller, async combined => {
        const result = await snapshot(source, input, combined);
        return { revision: publicRevision(source, result.revision), value: redactDataValue(source.definition.schema, result.value) };
      });
    },
    async write(id, request, caller) {
      const source = entry(id);
      const write = source.definition.write;
      if (!write) return dataError('data_read_only', '此数据源只读');
      if (hasSecretSchema(source.definition.schema)) return dataError('sensitive_data_write', '含敏感字段的数据源不能整体替换，请登记独立的无敏感业务投影');
      if (source.writing) return dataError('data_source_busy', '此数据源已有写入等待，不隐式排队或重放');
      text(request.expectedRevision, '预期数据修订', 128);
      const expectedRevision = source.revisions.get(request.expectedRevision);
      if (expectedRevision === undefined) return dataError('revision_conflict', '修订不属于当前数据源登记或已过期，请重新读取后修改');
      const value = copyDataJson(request.value);
      if (hasSecretData(value)) return dataError('sensitive_data_write', '不能通过调试器写入凭据字段，请使用无敏感业务投影');
      if (!source.validate(value)) return dataError('invalid_data', '待写入数据不符合数据源模式');
      source.writing = true;
      try {
        return await run(source, caller, async (combined, startingWrite) => {
          const before = await snapshot(source, null, combined);
          if (hasSecretData(before.value)) return dataError('sensitive_data_write', '现有数据包含敏感字段，请登记独立的无敏感业务投影');
          if (before.revision !== expectedRevision) return dataError('revision_conflict', '数据已变更，请重新读取后再修改');
          if (changedReadonlyData(source.definition.schema, before.value, value)) return dataError('data_read_only', '不能修改声明为只读的业务字段');
          startingWrite();
          try { await write({ expectedRevision, value }, combined); }
          catch (error) {
            if (error instanceof HostError && error.code === 'debugger_revision_conflict') return dataError('revision_conflict', '数据在写入前已变更，请重新读取后再修改');
            return dataError('result_unconfirmed', '插件写入未确认，请重新读取实际状态；不会自动重放');
          }
          combined.throwIfAborted();
          let after: DebugDataSnapshot;
          try { after = await snapshot(source, null, combined); }
          catch { return dataError('result_unconfirmed', '插件写入已返回，但回读失败；请查询实际状态，不会自动重放'); }
          combined.throwIfAborted();
          return { revision: publicRevision(source, after.revision), value: redactDataValue(source.definition.schema, after.value) };
        });
      } finally { source.writing = false; }
    },
    dispose,
  };
}
