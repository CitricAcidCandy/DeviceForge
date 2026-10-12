import { ApiError } from '../../shared/api/index.ts';
import { jsonObject, naturalNumber, onlyKeys } from '../../shared/jobs/index.ts';
import type { FridaAction } from './types.ts';

export const boundedFridaText = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.length > 0 && new TextEncoder().encode(value).length <= maximum && !/\p{Cc}/u.test(value);
export const fridaDeviceId = (value: unknown): value is string => boundedFridaText(value, 255) && /^[A-Za-z0-9._:][A-Za-z0-9._:-]*$/.test(value);
export const fridaPackage = (value: unknown): value is string => boundedFridaText(value, 255) && /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/.test(value);
export const fridaDuration = (value: unknown): value is number => naturalNumber(value) && value >= 100 && value <= 120000;
const modules = ['permissions', 'phone', 'system', 'packages', 'location', 'camera', 'network', 'bluetooth', 'files', 'media', 'sensor'];
function hook(value: unknown): boolean {
  if (!jsonObject(value) || !onlyKeys(value, ['class', 'method', 'module', 'action', 'messages', 'args'])
    || !boundedFridaText(value.class, 255) || !/^[A-Za-z0-9._$]+$/.test(value.class) || !boundedFridaText(value.method, 255) || !/^[A-Za-z0-9_$]+$/.test(value.method)
    || !boundedFridaText(value.action, 512) || !boundedFridaText(value.messages, 2048)
    || value.module !== undefined && (typeof value.module !== 'string' || new TextEncoder().encode(value.module).length > 255)) return false;
  return value.args === undefined || Array.isArray(value.args) && value.args.length <= 32 && value.args.every((arg) => boundedFridaText(arg, 2048));
}
export function requireFridaInput(action: FridaAction, deviceId: string, input: unknown): void {
  let valid = fridaDeviceId(deviceId) && jsonObject(input);
  if (jsonObject(input)) {
    if (action === 'server.status' || action === 'processes') valid &&= onlyKeys(input, []);
    else if (action === 'server.deploy') valid &&= onlyKeys(input, ['artifact_id']) && boundedFridaText(input.artifact_id, 128);
    else if (action === 'server.run') valid &&= onlyKeys(input, ['duration_ms']) && fridaDuration(input.duration_ms);
    else {
      valid &&= fridaPackage(input.package) && (input.mode === 'spawn' || input.mode === 'attach') && fridaDuration(input.duration_ms);
      if (action === 'script.run') valid &&= onlyKeys(input, ['package', 'mode', 'duration_ms', 'script_artifact_id']) && boundedFridaText(input.script_artifact_id, 128);
      else valid &&= onlyKeys(input, ['package', 'mode', 'duration_ms', 'modules', 'hooks', 'show_log'])
        && (input.modules === undefined || Array.isArray(input.modules) && input.modules.length <= 11 && input.modules.every((module) => typeof module === 'string' && modules.includes(module)))
        && (input.hooks === undefined || Array.isArray(input.hooks) && input.hooks.length <= 256 && input.hooks.every(hook))
        && (input.show_log === undefined || typeof input.show_log === 'boolean');
    }
  }
  if (!valid) throw new ApiError('protocol', 'invalid_frida_input', 'Frida 设备、产物身份、时长或 Hook 业务输入无效');
}
