import { MAX_FILE_COUNT, MAX_FOLDER_BYTES, MAX_PLUGIN_BYTES, safeRelativePath } from './rules.ts';

export interface ZipRecord { readonly size: number; readonly crc: number; readonly mode: number }
export function zipDirectory(bytes: Uint8Array, plugin: boolean): Map<string, ZipRecord> {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let offset = bytes.byteLength - 22; offset >= Math.max(0, bytes.byteLength - 65557); offset--) {
    if (data.getUint32(offset, true) === 0x06054b50 && offset + 22 + data.getUint16(offset + 20, true) === bytes.byteLength) { end = offset; break; }
  }
  if (end < 0) throw new Error('ZIP 目录缺失或归档被截断');
  const count = data.getUint16(end + 10, true);
  const size = data.getUint32(end + 12, true);
  const start = data.getUint32(end + 16, true);
  if (data.getUint16(end + 4, true) || data.getUint16(end + 6, true) || data.getUint16(end + 8, true) !== count || count === 0xffff || start === 0xffffffff || size === 0xffffffff)
    throw new Error('不支持分卷或 ZIP64 归档，请使用标准 ZIP/TGZ');
  if (count > MAX_FILE_COUNT || start + size > end) throw new Error('ZIP 目录大小或条目数量无效');
  const records = new Map<string, ZipRecord>();
  const names = new Set<string>();
  let offset = start;
  let total = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > start + size || data.getUint32(offset, true) !== 0x02014b50) throw new Error('ZIP 目录结构损坏');
    const nameLength = data.getUint16(offset + 28, true);
    const length = 46 + nameLength + data.getUint16(offset + 30, true) + data.getUint16(offset + 32, true);
    if (offset + length > start + size) throw new Error('ZIP 文件名长度无效');
    const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    const directory = name.endsWith('/');
    const path = safeRelativePath(directory ? name.slice(0, -1) : name);
    if (names.has(path.toLowerCase())) throw new Error(`重复文件路径：${path}`);
    names.add(path.toLowerCase());
    const flags = data.getUint16(offset + 8, true);
    const mode = data.getUint32(offset + 38, true) >>> 16;
    if (flags & 1) throw new Error('不支持加密 ZIP');
    if ((mode & 0o170000) === 0o120000) throw new Error('归档不支持符号链接');
    const originalSize = data.getUint32(offset + 24, true);
    total += originalSize;
    if (total > MAX_FOLDER_BYTES || (plugin && originalSize > MAX_PLUGIN_BYTES)) throw new Error('归档展开超过大小限制');
    if (!directory) records.set(path, { size: originalSize, crc: data.getUint32(offset + 16, true), mode: mode || 0o100644 });
    offset += length;
  }
  if (offset !== start + size) throw new Error('ZIP 目录长度不一致');
  return records;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
export function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = (crcTable[(value ^ byte) & 255] ?? 0) ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
