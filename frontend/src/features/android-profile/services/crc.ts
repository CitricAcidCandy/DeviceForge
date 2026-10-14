import { checkArchiveCancellation } from '../utils/cancellation.ts';
export { checkArchiveCancellation } from '../utils/cancellation.ts';

const table = new Uint32Array(256);
for (let index = 0; index < table.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  table[index] = value >>> 0;
}
// PNG 与 Stored ZIP 共用 IEEE CRC32；每 64 KiB 检查一次取消。
export function crc32(bytes: Uint8Array, signal?: AbortSignal, logId: string | null = null): number {
  let value = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    if ((index & 65535) === 0) checkArchiveCancellation(signal, logId);
    value = (table[(value ^ (bytes[index] ?? 0)) & 255] ?? 0) ^ value >>> 8;
  }
  checkArchiveCancellation(signal, logId); return (value ^ 0xffffffff) >>> 0;
}
