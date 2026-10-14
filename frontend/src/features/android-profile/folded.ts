import { PROFILE_LIMITS } from './rules.ts';
import { checkArchiveCancellation } from './crc.ts';
import { archiveError } from './zip.ts';
import type { ProfileResult, StackSample } from './types.ts';

export const PROFILE_FOLDED_LIMITS = Object.freeze({ bytes: 32 * 1024 * 1024, frames: 1000000 });
interface FoldedEntry { readonly key: string; readonly bytes: Uint8Array; count: bigint }
const escapeLabel = (text: string): string => text.replace(/[%;\r\n]/g, value =>
  value === '%' ? '%25' : value === ';' ? '%3B' : value === '\r' ? '%0D' : '%0A');
function byteOrder(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const first = left[index] ?? 0; const second = right[index] ?? 0;
    if (first !== second) return first - second;
  }
  return left.length - right.length;
}
function keyFor(sample: StackSample, logId: string | null, signal?: AbortSignal): string {
  const parts = [escapeLabel('event=' + JSON.stringify(sample.event_type)), 'pid=' + (sample.process_id ?? 'null'), 'tid=' + sample.thread_id];
  // 报告原链为叶到根；folded 只反转链顺序，未知地址保留原始文本。
  for (let index = sample.callchain.length - 1; index >= 0; index -= 1) {
    if ((index & 63) === 0) checkArchiveCancellation(signal, logId);
    const frame = sample.callchain[index];
    if (!frame) throw archiveError('invalid_profile_folded', logId);
    const symbol = frame.symbol === null || frame.symbol.length === 0 ? null : frame.symbol;
    parts.push(escapeLabel(JSON.stringify([frame.execution_type, frame.file, symbol, symbol === null ? frame.address : null])));
  }
  return parts.join(';');
}
// 发布成员固定为每条非空链权重1；不从原event_count换算耗时。
export function buildProfileFolded(stacks: readonly StackSample[], logId: string | null = null, signal?: AbortSignal): string {
  checkArchiveCancellation(signal, logId);
  if (stacks.length > PROFILE_LIMITS.stacks) throw archiveError('invalid_profile_folded_size', logId);
  const encoder = new TextEncoder(); const grouped = new Map<string, FoldedEntry>();
  let frames = 0; let reservedBytes = 0;
  for (const [index, sample] of stacks.entries()) {
    if ((index & 255) === 0) checkArchiveCancellation(signal, logId);
    frames += sample.callchain.length;
    if (sample.callchain.length > PROFILE_LIMITS.chain || frames > PROFILE_FOLDED_LIMITS.frames) throw archiveError('invalid_profile_folded_size', logId);
    if (sample.callchain.length === 0) continue;
    const key = keyFor(sample, logId, signal); const found = grouped.get(key);
    if (found) { found.count += 1n; continue; }
    const bytes = encoder.encode(key);
    // 与后端一致，每条新路径预留空格、最多39位十进制及换行。
    reservedBytes += bytes.length + 41;
    if (reservedBytes > PROFILE_FOLDED_LIMITS.bytes) throw archiveError('invalid_profile_folded_size', logId);
    grouped.set(key, { key, bytes, count: 1n });
  }
  const entries = [...grouped.values()].sort((left, right) => byteOrder(left.bytes, right.bytes));
  const lines: string[] = [];
  for (const [index, entry] of entries.entries()) {
    if ((index & 255) === 0) checkArchiveCancellation(signal, logId);
    lines.push(entry.key + ' ' + entry.count.toString() + '\n');
  }
  checkArchiveCancellation(signal, logId); return lines.join('');
}

export function decodeProfileFolded(bytes: Uint8Array, result: ProfileResult, stacks: readonly StackSample[], logId: string | null = null, signal?: AbortSignal): Blob {
  checkArchiveCancellation(signal, logId);
  if (result.root_access === 'none' || result.stack_status !== 'captured') throw archiveError('unexpected_profile_folded', logId);
  if (bytes.byteLength > PROFILE_FOLDED_LIMITS.bytes) throw archiveError('invalid_profile_folded_size', logId);
  let text: string;
  // 保留 BOM，严格比对发布原字节所表示的文本，不吞掉额外前缀。
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw archiveError('invalid_profile_folded_utf8', logId); }
  const expected = buildProfileFolded(stacks, logId, signal);
  if (text !== expected) throw archiveError('profile_folded_mismatch', logId);
  checkArchiveCancellation(signal, logId);
  return new Blob([Uint8Array.from(bytes)], { type: 'text/plain;charset=utf-8' });
}
