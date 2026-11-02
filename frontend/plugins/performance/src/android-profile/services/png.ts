import { crc32, checkArchiveCancellation } from './crc.ts';
import { archiveError } from './zip.ts';

export interface PngInfo {
  readonly width: number;
  readonly height: number;
}
// 校验 PNG 容器和解码尺寸资格，不以此证明视觉内容或解码器实际可播放。
export function validateProfilePng(
  bytes: Uint8Array,
  logId: string | null = null,
  signal?: AbortSignal,
): PngInfo {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 45 || !signature.every((value, index) => bytes[index] === value))
    throw archiveError('invalid_profile_png', logId);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let data = false;
  let dataEnded = false;
  let palette = false;
  let color = -1;
  let chunks = 0;
  while (offset + 12 <= bytes.length) {
    checkArchiveCancellation(signal, logId);
    chunks += 1;
    if (chunks > 65536) throw archiveError('invalid_profile_png', logId);
    const size = view.getUint32(offset);
    const next = offset + 12 + size;
    if (next > bytes.length) throw archiveError('invalid_profile_png', logId);
    const kind = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (
      !/^[a-zA-Z]{4}$/.test(kind) ||
      crc32(bytes.subarray(offset + 4, offset + 8 + size), signal, logId) !==
        view.getUint32(offset + 8 + size)
    )
      throw archiveError('profile_png_crc_mismatch', logId);
    if (offset === 8) {
      if (kind !== 'IHDR' || size !== 13) throw archiveError('invalid_profile_png', logId);
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      const depth = bytes[offset + 16];
      color = bytes[offset + 17] ?? -1;
      const validDepth =
        color === 0
          ? [1, 2, 4, 8, 16].includes(depth ?? -1)
          : color === 3
            ? [1, 2, 4, 8].includes(depth ?? -1)
            : [2, 4, 6].includes(color) && [8, 16].includes(depth ?? -1);
      if (
        width < 1 ||
        height < 1 ||
        width > 16384 ||
        height > 16384 ||
        width * height > 67108864 ||
        !validDepth ||
        bytes[offset + 18] !== 0 ||
        bytes[offset + 19] !== 0 ||
        ![0, 1].includes(bytes[offset + 20] ?? -1)
      )
        throw archiveError('invalid_profile_png_dimensions', logId);
    } else if (kind === 'IHDR') throw archiveError('invalid_profile_png', logId);
    else if (kind === 'PLTE') {
      if (
        palette ||
        data ||
        size === 0 ||
        size % 3 !== 0 ||
        size > 768 ||
        color === 0 ||
        color === 4
      )
        throw archiveError('invalid_profile_png', logId);
      palette = true;
    } else if (kind === 'IDAT') {
      if (dataEnded || (color === 3 && !palette)) throw archiveError('invalid_profile_png', logId);
      data = true;
    } else if (kind === 'IEND') {
      if (size !== 0 || !data || next !== bytes.length)
        throw archiveError('invalid_profile_png', logId);
      return { width, height };
    } else {
      if (data) dataEnded = true;
      if (kind[0] === kind[0]?.toUpperCase())
        throw archiveError('unsupported_profile_png_chunk', logId);
    }
    offset = next;
  }
  throw archiveError('invalid_profile_png', logId);
}
