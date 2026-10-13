import { ApiError } from '../../shared/api/index.ts';
import { jsonObject, naturalNumber, onlyKeys } from '../../shared/jobs/index.ts';

export function frozenMirroringCopy<T>(value: T): T {
  const copied: T = structuredClone(value);
  function freeze(item: unknown): void {
    if (item !== null && typeof item === 'object') { for (const child of Object.values(item)) freeze(child); Object.freeze(item); }
  }
  freeze(copied); return copied;
}
export function validMirroringUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
export const mirroringDeviceId = (value: unknown): value is string => typeof value === 'string' && value.length <= 200 && /^[A-Za-z0-9._:][A-Za-z0-9._:-]*$/.test(value);
export function requireMirroringRequest(value: unknown): void {
  if (!jsonObject(value) || !onlyKeys(value, ['device_id', 'duration_ms', 'max_size', 'max_fps']) || !mirroringDeviceId(value.device_id)
    || !naturalNumber(value.duration_ms) || value.duration_ms < 1000 || value.duration_ms > 120000
    || value.max_size !== undefined && (!naturalNumber(value.max_size) || value.max_size < 64 || value.max_size > 4096)
    || value.max_fps !== undefined && (!naturalNumber(value.max_fps) || value.max_fps < 1 || value.max_fps > 60)) throw new ApiError('protocol', 'invalid_mirroring_input', '投屏录像设备、时长或编码参数无效');
}
export function isMp4Header(header: ArrayBuffer): boolean {
  if (header.byteLength < 12) return false;
  const bytes = new Uint8Array(header);
  return new DataView(header).getUint32(0) >= 12 && bytes[4] === 102 && bytes[5] === 116 && bytes[6] === 121 && bytes[7] === 112;
}
