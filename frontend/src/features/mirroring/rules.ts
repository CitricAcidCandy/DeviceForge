import { ApiError } from '../../shared/api/index.ts';
import { jsonObject, naturalNumber, onlyKeys } from '../../shared/jobs/index.ts';

export function requireMirroringRequest(value: unknown): void {
  if (!jsonObject(value) || !onlyKeys(value, ['device_id', 'duration_ms', 'max_size', 'max_fps']) || typeof value.device_id !== 'string' || value.device_id.length > 200
    || !/^[A-Za-z0-9._:][A-Za-z0-9._:-]*$/.test(value.device_id) || !naturalNumber(value.duration_ms) || value.duration_ms < 1000 || value.duration_ms > 120000
    || value.max_size !== undefined && (!naturalNumber(value.max_size) || value.max_size < 64 || value.max_size > 4096)
    || value.max_fps !== undefined && (!naturalNumber(value.max_fps) || value.max_fps < 1 || value.max_fps > 60)) throw new ApiError('protocol', 'invalid_mirroring_input', '投屏录像设备、时长或编码参数无效');
}
export function isMp4Header(header: ArrayBuffer): boolean {
  if (header.byteLength < 12) return false;
  const bytes = new Uint8Array(header);
  return new DataView(header).getUint32(0) >= 12 && bytes[4] === 102 && bytes[5] === 116 && bytes[6] === 121 && bytes[7] === 112;
}
