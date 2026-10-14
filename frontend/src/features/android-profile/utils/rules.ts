import { ApiError } from '../../../services/api/index.ts';
import { isRecord } from '../../../services/api/validation.ts';
import { decimalU64, onlyKeys } from '../../../shared/jobs/index.ts';
import type { ProfileRequest, ProfileReference } from '../types/index.ts';

export const PROFILE_LIMITS = Object.freeze({
  indexBytes: 1024 * 1024,
  samples: 16,
  indicesPerSample: 4096,
  stacks: 100000,
  chain: 256,
  jsonlBytes: 32 * 1024 * 1024,
  lineBytes: 512 * 1024,
  frameBytes: 4 * 1024 * 1024,
  archiveBytes: 64 * 1024 * 1024,
});
export const integer = (
  value: unknown,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
export const packageName = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 200 &&
  /^[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)+$/.test(value);
export const deviceId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 200 &&
  /^[a-zA-Z0-9._:\[\]][a-zA-Z0-9._:\[\]-]*$/.test(value);
export const boundedText = (value: unknown, bytes = 4096): value is string =>
  typeof value === 'string' &&
  new TextEncoder().encode(value).length <= bytes &&
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
export const nullableText = (value: unknown, bytes = 4096): value is string | null =>
  value === null || boundedText(value, bytes);
export const nanosecondRange = (begin: unknown, end: unknown): boolean =>
  decimalU64(begin) && decimalU64(end) && BigInt(begin) <= BigInt(end);
export function requireReference(value: ProfileReference): void {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ['providerId', 'generation', 'localId']) ||
    value.providerId !== 'android-device' ||
    !boundedText(value.generation, 200) ||
    value.generation.length === 0 ||
    !deviceId(value.localId)
  )
    throw invalidInput();
}
export function requirePackage(value: unknown): asserts value is string {
  if (!packageName(value)) throw invalidInput();
}
export function requireProfileRequest(value: unknown): asserts value is ProfileRequest {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ['package', 'duration_ms', 'interval_ms', 'capture_frames']) ||
    !packageName(value.package) ||
    !integer(value.duration_ms, 1000, 15000) ||
    !integer(value.interval_ms, 1000, value.duration_ms) ||
    !(value.capture_frames === undefined || typeof value.capture_frames === 'boolean')
  )
    throw invalidInput();
}
export function invalidInput(): ApiError {
  return new ApiError(
    'protocol',
    'invalid_android_profile_input',
    'Android 堆栈录制输入不符合公开范围',
  );
}
export function invalidProfile(logId: string | null): ApiError {
  return new ApiError(
    'protocol',
    'invalid_android_profile_result',
    'Android 堆栈录制结果不兼容或关联归属无效',
    null,
    logId,
  );
}
