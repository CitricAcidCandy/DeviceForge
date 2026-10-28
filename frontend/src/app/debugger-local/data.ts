import type { JsonValue } from '../../plugin-sdk/index.ts';
import { copyDataJson } from '../../plugins/debugger/index.ts';
import type { AttachedDebug } from './types.ts';
import { fail, keys, text, unavailable } from './validation.ts';

export async function executeData(tool: string, entry: AttachedDebug | undefined, input: Record<string, unknown>, signal: AbortSignal): Promise<JsonValue> {
  if (tool === 'data_catalog') {
    keys(input, []);
    return copyDataJson({ sources: entry?.registry.data.catalog() ?? [], source: 'plugin-registered',
      coverage: '仅当前插件主动登记的数据源；空目录不代表插件没有内部状态' }, false, 1024 * 1024);
  }
  if (!entry) return unavailable('当前插件尚未接入数据源登记');
  if (tool === 'data_read') {
    keys(input, ['source_id', 'query']);
    const source_id = text(input['source_id'], '数据源标识', 128);
    const result = await entry.registry.data.read(source_id, copyDataJson(input['query'] ?? null), signal);
    const info = entry.registry.data.catalog().find(source => source.id === source_id);
    return copyDataJson({ source_id, ...result, writable: info?.writable ?? false,
      apply_policy: info?.apply_policy ?? 'immediate' }, false, 1024 * 1024);
  }
  keys(input, ['source_id', 'expected_revision', 'value', 'confirmed']);
  if (input['confirmed'] !== true) return fail('confirmation_required', '数据写入需要显式确认本次修改');
  const source_id = text(input['source_id'], '数据源标识', 128);
  const expectedRevision = text(input['expected_revision'], '预期数据修订', 128);
  if (!Object.hasOwn(input, 'value')) return fail('invalid_parameters', '数据写入必须提供完整业务值');
  const result = await entry.registry.data.write(source_id, { expectedRevision, value: copyDataJson(input['value']) }, signal);
  const info = entry.registry.data.catalog().find(source => source.id === source_id);
  return copyDataJson({ source_id, ...result, writable: info?.writable ?? false,
    apply_policy: info?.apply_policy ?? 'immediate',
    runtime_applied: info?.apply_policy === 'immediate' ? 'declared' : 'pending' }, false, 1024 * 1024);
}
