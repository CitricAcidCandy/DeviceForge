import type { JsonValue } from '../../plugin-sdk/index.ts';
import { copyDataJson } from '../../plugins/debugger/index.ts';
import type { AttachedDebug } from './types.ts';
import { fail, keys, text, unavailable } from './validation.ts';

export function dataCatalog(entry: AttachedDebug | undefined) {
  return [...(entry?.registry.data.catalog() ?? []), ...(entry?.unifiedData.catalog() ?? [])];
}

export async function executeData(tool: string, entry: AttachedDebug | undefined, input: Record<string, unknown>, signal: AbortSignal): Promise<JsonValue> {
  if (tool === 'data_catalog') {
    keys(input, []);
    const sources = dataCatalog(entry);
    return copyDataJson({ sources, source: entry?.unifiedData.catalog().length ? 'public-and-plugin-registered' : 'plugin-registered',
      coverage: '仅当前明确目标的公开数据源及兼容调试登记；空目录不代表插件没有内部状态' }, false, 1024 * 1024);
  }
  if (!entry) return unavailable('当前插件尚未接入数据源登记');
  if (tool === 'data_read') {
    keys(input, ['source_id', 'query']);
    const source_id = text(input['source_id'], '数据源标识', 128);
    const unified = entry.unifiedData.has(source_id);
    if (unified && entry.registry.data.catalog().some(source => source.id === source_id))
      return fail('data_source_conflict', '公开数据源与兼容登记标识冲突，请重新查询目录');
    const result = await (unified ? entry.unifiedData : entry.registry.data).read(source_id, copyDataJson(input['query'] ?? null), signal);
    const info = dataCatalog(entry).find(source => source.id === source_id);
    return copyDataJson({ source_id, ...result, writable: info?.writable ?? false,
      apply_policy: info?.apply_policy ?? 'immediate' }, false, 1024 * 1024);
  }
  keys(input, ['source_id', 'expected_revision', 'value', 'confirmed']);
  if (input['confirmed'] !== true) return fail('confirmation_required', '数据写入需要显式确认本次修改');
  const source_id = text(input['source_id'], '数据源标识', 128);
  const expectedRevision = text(input['expected_revision'], '预期数据修订', 128);
  if (!Object.hasOwn(input, 'value')) return fail('invalid_parameters', '数据写入必须提供完整业务值');
  const unified = entry.unifiedData.has(source_id);
  if (unified && entry.registry.data.catalog().some(source => source.id === source_id))
    return fail('data_source_conflict', '公开数据源与兼容登记标识冲突，请重新查询目录');
  const result = await (unified ? entry.unifiedData : entry.registry.data).write(source_id, { expectedRevision, value: copyDataJson(input['value']) }, signal);
  const info = dataCatalog(entry).find(source => source.id === source_id);
  return copyDataJson({ source_id, ...result, writable: info?.writable ?? false,
    apply_policy: info?.apply_policy ?? 'immediate',
    runtime_applied: info?.apply_policy === 'immediate' ? 'declared' : 'pending' }, false, 1024 * 1024);
}
