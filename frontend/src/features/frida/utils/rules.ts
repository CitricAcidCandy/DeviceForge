import { ApiError } from '../../../services/api/index.ts';
import { jsonObject, naturalNumber, onlyKeys } from '../../../shared/jobs/index.ts';
import type { FridaAction } from '../types/index.ts';

export function validFridaUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
export function frozenFridaCopy<T>(value: T): T {
  const copied: T = structuredClone(value);
  function freeze(item: unknown): void {
    if (item !== null && typeof item === 'object') {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
  }
  freeze(copied);
  return copied;
}
export const boundedFridaText = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' &&
  validFridaUnicode(value) &&
  value.length > 0 &&
  new TextEncoder().encode(value).length <= maximum &&
  !/\p{Cc}/u.test(value);
export const fridaDeviceId = (value: unknown): value is string =>
  boundedFridaText(value, 255) && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
export const fridaPackage = (value: unknown): value is string =>
  boundedFridaText(value, 255) && /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/.test(value);
export const fridaDuration = (value: unknown): value is number =>
  naturalNumber(value) && value >= 100 && value <= 120000;
const modules = [
  'permissions',
  'phone',
  'system',
  'packages',
  'location',
  'camera',
  'network',
  'bluetooth',
  'files',
  'media',
  'sensor',
];
function hook(value: unknown): boolean {
  if (
    !jsonObject(value) ||
    !onlyKeys(value, ['class', 'method', 'module', 'action', 'messages', 'args']) ||
    !boundedFridaText(value.class, 255) ||
    !/^[A-Za-z0-9._$]+$/.test(value.class) ||
    !boundedFridaText(value.method, 255) ||
    !/^[A-Za-z0-9_$]+$/.test(value.method) ||
    !boundedFridaText(value.action, 512) ||
    !boundedFridaText(value.messages, 2048) ||
    (value.module !== undefined && value.module !== '' && !boundedFridaText(value.module, 255))
  )
    return false;
  return (
    value.args === undefined ||
    (Array.isArray(value.args) &&
      value.args.length <= 32 &&
      value.args.every((arg) => boundedFridaText(arg, 2048)))
  );
}
function validFridaBusinessInput(action: FridaAction, input: unknown): boolean {
  let valid = jsonObject(input);
  if (jsonObject(input)) {
    if (action === 'server.status' || action === 'processes') valid &&= onlyKeys(input, []);
    else if (action === 'server.deploy')
      valid &&= onlyKeys(input, ['artifact_id']) && boundedFridaText(input.artifact_id, 128);
    else if (action === 'server.run')
      valid &&= onlyKeys(input, ['duration_ms']) && fridaDuration(input.duration_ms);
    else {
      valid &&=
        fridaPackage(input.package) &&
        (input.mode === 'spawn' || input.mode === 'attach') &&
        fridaDuration(input.duration_ms);
      if (action === 'script.run')
        valid &&=
          onlyKeys(input, ['package', 'mode', 'duration_ms', 'script_artifact_id']) &&
          boundedFridaText(input.script_artifact_id, 128);
      else
        valid &&=
          onlyKeys(input, ['package', 'mode', 'duration_ms', 'modules', 'hooks', 'show_log']) &&
          (input.modules === undefined ||
            (Array.isArray(input.modules) &&
              input.modules.length <= 11 &&
              new Set(input.modules).size === input.modules.length &&
              input.modules.every(
                (module) => typeof module === 'string' && modules.includes(module),
              ))) &&
          (input.hooks === undefined ||
            (Array.isArray(input.hooks) && input.hooks.length <= 256 && input.hooks.every(hook))) &&
          (input.show_log === undefined || typeof input.show_log === 'boolean');
    }
  }
  return valid;
}
export function requireFridaBusinessInput(action: FridaAction, input: unknown): void {
  if (!validFridaBusinessInput(action, input))
    throw new ApiError('protocol', 'invalid_frida_input', 'Frida产物身份、时长或Hook业务输入无效');
}
export function requireFridaInput(action: FridaAction, deviceId: string, input: unknown): void {
  if (!fridaDeviceId(deviceId) || !validFridaBusinessInput(action, input))
    throw new ApiError(
      'protocol',
      'invalid_frida_input',
      'Frida设备、产物身份、时长或Hook业务输入无效',
    );
}
