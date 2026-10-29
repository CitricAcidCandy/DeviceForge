import { HostError } from '../../plugin-sdk/models.ts';
import type { DataSnapshot, DataSourceDefinition, DataSourceRef } from '../../plugin-sdk/data-sources.ts';
import type { JsonValue } from '../../plugin-sdk/models.ts';
import { isJsonValue } from '../../plugin-sdk/json.ts';

const identifier = /^[a-z][a-z0-9._-]{0,199}$/;

export function validateRef(ref: DataSourceRef): void {
  if (!identifier.test(ref.id) || typeof ref.version !== 'string' || !ref.version.trim() || ref.version.length > 128)
    throw new HostError('protocol', 'invalid_data_source_ref', '数据源或服务引用必须有合法标识和精确版本');
}

export function validateDefinition(pluginId: string, definition: DataSourceDefinition): void {
  validateRef(definition);
  if (!definition.id.startsWith(`${pluginId}.`))
    throw new HostError('protocol', 'data_source_namespace', '数据源必须属于登记插件的命名空间');
  if (typeof definition.title !== 'string' || !definition.title.trim() || definition.title.length > 160)
    throw new HostError('protocol', 'invalid_data_source_title', '数据源标题必须为 1 至 160 字符');
  if (typeof definition.readOnly !== 'boolean' || !['immediate', 'reload'].includes(definition.applyPolicy))
    throw new HostError('protocol', 'invalid_data_source_policy', '数据源必须明确只读状态及生效策略');
  if (definition.persistence !== undefined && !['memory', 'persistent'].includes(definition.persistence))
    throw new HostError('protocol', 'invalid_data_source_policy', '数据持久性声明只能为 memory 或 persistent');
  validateRef(definition.read);
  if (definition.readOnly && definition.write !== undefined)
    throw new HostError('protocol', 'invalid_data_source_policy', '只读数据源不能同时声明变更服务');
  if (!definition.readOnly && definition.write === undefined)
    throw new HostError('protocol', 'invalid_data_source_policy', '可修改数据源必须声明变更服务');
  if (definition.write) validateRef(definition.write);
  if (definition.schema !== undefined && !isJsonValue(definition.schema))
    throw new HostError('protocol', 'invalid_data_source_schema', '数据模式必须是 JSON 值');
}

export function revision(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096;
}

export function snapshot(value: JsonValue, logId: string | null): DataSnapshot {
  if (value === null || Array.isArray(value) || typeof value !== 'object' ||
      !Object.hasOwn(value, 'value') || !revision(value.revision))
    throw new HostError('protocol', 'invalid_data_snapshot', '数据服务必须返回 value 与非空 revision', logId);
  const data = value.value;
  if (!isJsonValue(data)) throw new HostError('protocol', 'invalid_data_snapshot', '数据服务返回值不是 JSON', logId);
  return { value: structuredClone(data), revision: value.revision };
}
