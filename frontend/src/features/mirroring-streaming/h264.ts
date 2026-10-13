import { ApiError } from '../../shared/api/index.ts';

export function mirroringH264Codec(bytes: Uint8Array): string {
  for (let offset = 0; offset + 6 < bytes.length; ++offset) {
    if (bytes[offset] !== 0 || bytes[offset + 1] !== 0) continue;
    const prefix = bytes[offset + 2] === 1 ? 3 : bytes[offset + 2] === 0 && bytes[offset + 3] === 1 ? 4 : 0;
    if (prefix === 0) continue;
    const index = offset + prefix; const nal = bytes[index];
    if (nal === undefined || (nal & 31) !== 7) continue;
    const profile = bytes[index + 1]; const compatibility = bytes[index + 2]; const level = bytes[index + 3];
    if (profile === undefined || compatibility === undefined || level === undefined) break;
    return `avc1.${[profile, compatibility, level].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
  }
  throw new ApiError('protocol', 'invalid_mirroring_h264_config', 'H264 配置包缺少 Annex B 的 SPS 头');
}
export function prependMirroringH264Configuration(configuration: Uint8Array, packet: Uint8Array): Uint8Array {
  if (configuration.length + packet.length > 4 * 1024 * 1024) throw new ApiError('protocol', 'mirroring_h264_packet_limit', 'H264 配置与关键帧合并后超过解码限额');
  const combined = new Uint8Array(configuration.length + packet.length); combined.set(configuration); combined.set(packet, configuration.length); return combined;
}
