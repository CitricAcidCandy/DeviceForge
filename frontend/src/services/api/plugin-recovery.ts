import type { paths } from './generated.ts';
import type { Endpoint } from './types.ts';
import { encodedId } from './endpoints.ts';
import { isRecord } from './validation.ts';
import { isSchemaValue } from '../../utils/schema.ts';

type RecoveryPath = paths['/api/v2/plugins/{id}/recovery'];
export type PluginRecoveryView = RecoveryPath['get']['responses'][200]['content']['application/json']['data'];
export type PluginRecoveryInput = RecoveryPath['post']['requestBody']['content']['application/json'];

function boundedText(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  // 与 SDK 的 chars().count() 对齐，按 Unicode 码点而非 UTF-16 单元计数。
  let count = 0;
  for (const _character of value) if (++count > 500) return false;
  return true;
}

export function isPluginRecoveryView(value: unknown): value is PluginRecoveryView {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim() ||
    typeof value.generation !== 'string' || !value.generation.trim() ||
    typeof value.supported !== 'boolean' || typeof value.cleanup_failed !== 'boolean' ||
    typeof value.recovering !== 'boolean') return false;
  const report = value.last_report;
  if (report === null) return true;
  return isRecord(report) && report.coverage === 'plugin' &&
    typeof report.inspected === 'number' && Number.isSafeInteger(report.inspected) && report.inspected >= 0 &&
    typeof report.remaining === 'number' && Number.isSafeInteger(report.remaining) && report.remaining >= 0 &&
    (report.status === 'recovered' || report.status === 'blocked' || report.status === 'busy') &&
    boundedText(report.message) && Array.isArray(report.checks) && report.checks.length <= 64 &&
    report.checks.every((check: unknown) => isRecord(check) &&
      boundedText(check.resource) &&
      (check.status === 'confirmed' || check.status === 'blocked' || check.status === 'busy') &&
      boundedText(check.message)) &&
    (report.status !== 'recovered' || report.remaining === 0 && report.checks.length > 0 &&
      report.checks.every((check: unknown) => isRecord(check) && check.status === 'confirmed'));
}

const path = (id: string) => `/api/v2/plugins/${encodedId(id)}/recovery`;
export const pluginRecoveryEndpoint: Endpoint<string, PluginRecoveryView> = {
  request: (id) => ({ path: path(id), method: 'GET' }),
  decode: isPluginRecoveryView,
};
export const recoverPluginEndpoint: Endpoint<{ id: string; body: PluginRecoveryInput }, PluginRecoveryView> = {
  request: ({ id, body }) => {
    if (typeof body.generation !== 'string' || !body.generation.trim() ||
      !isRecord(body.input) || !isSchemaValue(body.input))
      throw new Error('核对恢复必须携带当前插件代际与 JSON 对象输入');
    return { path: path(id), method: 'POST', body: JSON.stringify(body), contentType: 'application/json' };
  },
  decode: isPluginRecoveryView,
};
