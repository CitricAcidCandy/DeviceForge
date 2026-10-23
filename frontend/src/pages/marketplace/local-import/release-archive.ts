import { inflateSync } from 'fflate';
import { safeRelativePath } from '../upload-preparation/rules.ts';
import { crc32 } from '../upload-preparation/zip-directory.ts';

export interface ReleaseArchiveEntry { readonly name: string; readonly size: number; readonly compressed: number; readonly offset: number; readonly method: number; readonly crc: number }
const MANIFEST_LIMIT = 256 * 1024;
async function bytes(file: Blob, start: number, end: number, signal: AbortSignal) {
  signal.throwIfAborted();
  if (start < 0 || end < start || end > file.size) throw new Error('离线 ZIP 结构被截断');
  const value = new Uint8Array(await file.slice(start, end).arrayBuffer());
  signal.throwIfAborted();
  return value;
}
export async function releaseArchive(file: File, signal: AbortSignal) {
  const tailStart = Math.max(0, file.size - 65557);
  const tail = await bytes(file, tailStart, file.size, signal);
  const data = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let end = -1;
  for (let offset = tail.byteLength - 22; offset >= 0; --offset) {
    if (data.getUint32(offset, true) === 0x06054b50 && offset + 22 + data.getUint16(offset + 20, true) === tail.byteLength) { end = offset; break; }
  }
  if (end < 0) throw new Error('ZIP 目录缺失或归档被截断');
  const count = data.getUint16(end + 10, true), size = data.getUint32(end + 12, true), start = data.getUint32(end + 16, true);
  if (data.getUint16(end + 4, true) || data.getUint16(end + 6, true) || data.getUint16(end + 8, true) !== count ||
      count === 0xffff || start === 0xffffffff || size === 0xffffffff) throw new Error('本地预览暂不支持分卷或 ZIP64，请使用标准完整 ZIP');
  if (count > 4096 || size > 8 * 1024 * 1024 || start + size > tailStart + end) throw new Error('离线 ZIP 目录超过预览限制');
  const directory = await bytes(file, start, start + size, signal);
  const view = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);
  const entries = new Map<string, ReleaseArchiveEntry>();
  let position = 0;
  for (let index = 0; index < count; ++index) {
    if (position + 46 > directory.length || view.getUint32(position, true) !== 0x02014b50) throw new Error('离线 ZIP 目录结构损坏');
    const nameLength = view.getUint16(position + 28, true);
    const length = 46 + nameLength + view.getUint16(position + 30, true) + view.getUint16(position + 32, true);
    if (position + length > directory.length) throw new Error('离线 ZIP 文件名长度无效');
    const name = new TextDecoder('utf-8', { fatal: true }).decode(directory.subarray(position + 46, position + 46 + nameLength));
    const path = safeRelativePath(name.endsWith('/') ? name.slice(0, -1) : name);
    const key = path.toLowerCase();
    if (entries.has(key)) throw new Error('离线 ZIP 包含重复路径');
    const mode = view.getUint32(position + 38, true) >>> 16;
    const flags = view.getUint16(position + 8, true), method = view.getUint16(position + 10, true);
    if ((flags & 1) || ![0, 8].includes(method) || ((mode & 0o170000) !== 0 && ![0o100000, 0o040000].includes(mode & 0o170000)))
      throw new Error('离线 ZIP 不支持加密、特殊文件或当前压缩格式');
    const entry: ReleaseArchiveEntry = { name: path, size: view.getUint32(position + 24, true), compressed: view.getUint32(position + 20, true),
      offset: view.getUint32(position + 42, true), method, crc: view.getUint32(position + 16, true) };
    if ([entry.size, entry.compressed, entry.offset].includes(0xffffffff) || entry.offset + 30 + entry.compressed > start)
      throw new Error('离线 ZIP 资源位置无效或使用 ZIP64');
    entries.set(key, entry);
    position += length;
  }
  if (position !== directory.length) throw new Error('离线 ZIP 目录长度不一致');
  const manifest = entries.get('release.json');
  if (!manifest || manifest.name !== 'release.json') return null;
  if (manifest.size > MANIFEST_LIMIT || manifest.compressed > MANIFEST_LIMIT) throw new Error('release.json 超过 256 KiB');
  const header = await bytes(file, manifest.offset, manifest.offset + 30, signal);
  const local = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (local.getUint32(0, true) !== 0x04034b50 || local.getUint16(8, true) !== manifest.method || (local.getUint16(6, true) & 1))
    throw new Error('release.json 本地文件头不一致');
  const nameSize = local.getUint16(26, true), extraSize = local.getUint16(28, true);
  const name = new TextDecoder('utf-8', { fatal: true }).decode(await bytes(file, manifest.offset + 30, manifest.offset + 30 + nameSize, signal));
  if (name !== 'release.json') throw new Error('release.json 本地路径不一致');
  const contentStart = manifest.offset + 30 + nameSize + extraSize;
  if (contentStart + manifest.compressed > start) throw new Error('release.json 资源长度无效');
  const compressed = await bytes(file, contentStart, contentStart + manifest.compressed, signal);
  // 固定缓冲区避免伪造展开大小导致动态扩容，额外一个字节用来识别截断溢出。
  const output = manifest.method === 0 ? compressed : inflateSync(compressed, { out: new Uint8Array(manifest.size + 1) });
  if (output.byteLength !== manifest.size || crc32(output) !== manifest.crc) throw new Error('release.json 大小或 CRC 不一致');
  return { manifest: output, entries, dataEnd: start };
}
