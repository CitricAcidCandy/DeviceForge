import { ApiError } from '../../../shared/api/index.ts';
import { PROFILE_LIMITS } from '../utils/rules.ts';
import { checkArchiveCancellation, crc32 } from './crc.ts';

export interface StoredFile { readonly filename: string; readonly bytes: Uint8Array }
interface Entry { readonly filename: string; readonly flags: number; readonly size: number; readonly crc: number; readonly offset: number }
export function archiveError(code: string, logId: string | null): ApiError {
  return new ApiError('protocol', code, '录制 ZIP 结构、字节完整性或资源范围不兼容', null, logId);
}
function hasZip64Extra(view: DataView, start: number, size: number, logId: string | null): boolean {
  const end = start + size;
  for (let offset = start; offset < end;) {
    if (offset + 4 > end) throw archiveError('invalid_profile_zip_extra', logId);
    const tag = view.getUint16(offset, true); const length = view.getUint16(offset + 2, true);
    if (offset + 4 + length > end) throw archiveError('invalid_profile_zip_extra', logId);
    if (tag === 1) return true;
    offset += 4 + length;
  }
  return false;
}
function filename(bytes: Uint8Array, logId: string | null): string {
  let value: string;
  try { value = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw archiveError('invalid_profile_zip_name', logId); }
  if (!['profile-index.json', 'stacks.jsonl', 'perf.bin', 'stack-quality.json', 'flamegraph.folded'].includes(value) && !/^frames\/[0-9]{6}\.png$/.test(value)) throw archiveError('invalid_profile_zip_name', logId);
  return value;
}
// 仅支持本批 seekable 文件发布的 Stored ZIP；data descriptor、Deflate、ZIP64 与分卷明确拒绝。
export function decodeStoredProfileZip(bytes: Uint8Array, logId: string | null = null, signal?: AbortSignal): readonly StoredFile[] {
  checkArchiveCancellation(signal, logId);
  if (bytes.byteLength < 22 || bytes.byteLength > PROFILE_LIMITS.archiveBytes) throw archiveError('invalid_profile_zip_size', logId);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === bytes.length) { end = offset; break; }
  }
  if (end < 0) throw archiveError('invalid_profile_zip_end', logId);
  const count = view.getUint16(end + 10, true); const size = view.getUint32(end + 12, true); const start = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0 || view.getUint16(end + 8, true) !== count
    || count < 2 || count > PROFILE_LIMITS.samples + 5 || start + size !== end || start > end) throw archiveError('unsupported_profile_zip_layout', logId);
  const entries: Entry[] = []; const names = new Set<string>(); let total = 0; let cursor = start;
  for (let index = 0; index < count; index += 1) {
    checkArchiveCancellation(signal, logId);
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) throw archiveError('invalid_profile_zip_directory', logId);
    const flags = view.getUint16(cursor + 8, true); const method = view.getUint16(cursor + 10, true);
    const compressed = view.getUint32(cursor + 20, true); const uncompressed = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true); const extraLength = view.getUint16(cursor + 30, true); const commentLength = view.getUint16(cursor + 32, true);
    const offset = view.getUint32(cursor + 42, true); const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end || nameLength < 1 || view.getUint16(cursor + 34, true) !== 0 || view.getUint16(cursor + 6, true) > 20) throw archiveError('unsupported_profile_zip_layout', logId);
    if ((flags & ~0x0800) !== 0) throw archiveError('unsupported_profile_zip_flags', logId);
    if (method !== 0) throw archiveError('unsupported_profile_zip_compression', logId);
    if (compressed !== uncompressed || uncompressed === 0xffffffff || offset === 0xffffffff || hasZip64Extra(view, cursor + 46 + nameLength, extraLength, logId)) throw archiveError('unsupported_profile_zip_size', logId);
    const name = filename(bytes.subarray(cursor + 46, cursor + 46 + nameLength), logId);
    if (names.has(name)) throw archiveError('duplicate_profile_zip_entry', logId);
    if (((view.getUint32(cursor + 38, true) >>> 16) & 0xf000) === 0xa000 || (view.getUint32(cursor + 38, true) & 0x10) !== 0) throw archiveError('invalid_profile_zip_entry_type', logId);
    total += uncompressed;
    const maximum = name === 'profile-index.json' || name === 'stack-quality.json' ? PROFILE_LIMITS.indexBytes : name === 'stacks.jsonl' || name === 'flamegraph.folded' ? PROFILE_LIMITS.jsonlBytes : name.startsWith('frames/') ? PROFILE_LIMITS.frameBytes : PROFILE_LIMITS.archiveBytes;
    if (uncompressed > maximum || total > PROFILE_LIMITS.archiveBytes) throw archiveError('invalid_profile_zip_size', logId);
    names.add(name); entries.push({ filename: name, flags, size: uncompressed, crc: view.getUint32(cursor + 16, true), offset }); cursor = next;
  }
  if (cursor !== end) throw archiveError('invalid_profile_zip_directory', logId);
  entries.sort((left, right) => left.offset - right.offset);
  const files: StoredFile[] = []; let localEnd = 0;
  for (const entry of entries) {
    const offset = entry.offset;
    if (offset !== localEnd || offset + 30 > start || view.getUint32(offset, true) !== 0x04034b50) throw archiveError('invalid_profile_zip_local', logId);
    const nameLength = view.getUint16(offset + 26, true); const extraLength = view.getUint16(offset + 28, true); const dataStart = offset + 30 + nameLength + extraLength;
    if (dataStart > start || dataStart + entry.size > start || view.getUint16(offset + 4, true) > 20 || view.getUint16(offset + 6, true) !== entry.flags
      || view.getUint16(offset + 8, true) !== 0 || view.getUint32(offset + 14, true) !== entry.crc || view.getUint32(offset + 18, true) !== entry.size
      || view.getUint32(offset + 22, true) !== entry.size || filename(bytes.subarray(offset + 30, offset + 30 + nameLength), logId) !== entry.filename
      || hasZip64Extra(view, offset + 30 + nameLength, extraLength, logId)) throw archiveError('invalid_profile_zip_local', logId);
    const content = bytes.subarray(dataStart, dataStart + entry.size);
    if (crc32(content, signal, logId) !== entry.crc) throw archiveError('profile_zip_crc_mismatch', logId);
    files.push({ filename: entry.filename, bytes: content }); localEnd = dataStart + entry.size;
  }
  if (localEnd !== start) throw archiveError('invalid_profile_zip_local', logId);
  return files;
}
