import { ApiError } from '../../../shared/api/index.ts';
import type { ApiResult } from '../../../shared/api/index.ts';
import { abortable } from '../../../shared/api/abort.ts';
import { downloadPublishedArtifact } from '../../../shared/jobs/index.ts';
import type { ArtifactReader, PublishedResult } from '../../../shared/jobs/index.ts';
import { downloadProfileArchive } from '../services/artifacts.ts';
import { checkArchiveCancellation } from '../services/crc.ts';
import { decodeProfileIndex } from '../utils/index-results.ts';
import { validateProfilePng } from '../services/png.ts';
import { invalidProfile } from '../utils/rules.ts';
import { decodeStackJsonLines } from '../services/stacks.ts';
import { decodeStackQuality } from '../utils/quality.ts';
import { decodeProfileFolded } from '../services/folded.ts';
import { buildProfileTimeline } from '../utils/timeline.ts';
import { archiveError, decodeStoredProfileZip } from '../services/zip.ts';
import type { StoredFile } from '../services/zip.ts';
import type { ProfileFrame, ProfileIndex, ProfileResult, ProfileTimeline, StackQuality, StackSample } from '../types/index.ts';

export interface OpenedProfileFrame { readonly reference: ProfileFrame; readonly content: Blob; readonly width: number; readonly height: number }
export interface OpenedProfileArchive {
  readonly index: ProfileIndex; readonly stacks: readonly StackSample[]; readonly timeline: ProfileTimeline;
  readonly frames: readonly OpenedProfileFrame[]; readonly perf: Blob | null; readonly quality: StackQuality | null; readonly folded: Blob | null;
}
function requiredFile(files: readonly StoredFile[], filename: string, logId: string | null): StoredFile {
  const file = files.find((entry) => entry.filename === filename);
  if (!file) throw archiveError('missing_profile_archive_entry', logId);
  return file;
}
function parseIndex(bytes: Uint8Array, result: ProfileResult, logId: string | null): ProfileIndex {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw invalidProfile(logId); }
  return decodeProfileIndex(value, result, logId);
}
// 从同一个已验证归档消费索引、堆栈和 PNG，失败不交付部分画面或部分关联。
function openProfileFiles(files: readonly StoredFile[], result: ProfileResult, logId: string | null, signal?: AbortSignal): OpenedProfileArchive {
  const index = parseIndex(requiredFile(files, 'profile-index.json', logId).bytes, result, logId);
  const stacks = decodeStackJsonLines(requiredFile(files, 'stacks.jsonl', logId).bytes, logId, signal);
  const expected = new Set(['profile-index.json', 'stacks.jsonl']);
  const qualityFile = files.find(file => file.filename === 'stack-quality.json');
  const quality = qualityFile ? decodeStackQuality(qualityFile.bytes, result, stacks, logId, signal) : null;
  if (qualityFile) expected.add('stack-quality.json');
  const foldedFile = files.find(file => file.filename === 'flamegraph.folded');
  const folded = foldedFile ? decodeProfileFolded(foldedFile.bytes, result, stacks, logId, signal) : null;
  if (foldedFile) expected.add('flamegraph.folded');
  let perf: Blob | null = null;
  if (result.stack_status === 'captured') {
    const trace = requiredFile(files, 'perf.bin', logId);
    if (trace.bytes.byteLength === 0) throw archiveError('missing_profile_trace', logId);
    perf = new Blob([Uint8Array.from(trace.bytes)]); expected.add('perf.bin');
  }
  const frames: OpenedProfileFrame[] = [];
  for (const sample of index.samples) {
    checkArchiveCancellation(signal, logId);
    if (!sample.frame) continue;
    const frame = requiredFile(files, sample.frame.filename, logId); const info = validateProfilePng(frame.bytes, logId, signal);
    expected.add(frame.filename); frames.push({ reference: sample.frame, content: new Blob([Uint8Array.from(frame.bytes)], { type: 'image/png' }), ...info });
  }
  if (files.length !== expected.size || files.some((file) => !expected.has(file.filename))) throw archiveError('unexpected_profile_archive_entry', logId);
  const timeline = buildProfileTimeline(index, stacks, logId);
  checkArchiveCancellation(signal, logId); return { index, stacks, timeline, frames, perf, quality, folded };
}
export function openProfileArchive(bytes: Uint8Array, result: ProfileResult, logId: string | null = null, signal?: AbortSignal): OpenedProfileArchive {
  return openProfileFiles(decodeStoredProfileZip(bytes, logId, signal), result, logId, signal);
}
export async function downloadAndOpenProfileArchive(reader: ArtifactReader, result: PublishedResult<ProfileResult>, signal: AbortSignal): Promise<ApiResult<OpenedProfileArchive>> {
  const downloaded = await downloadProfileArchive(reader, result, signal);
  try {
    const bytes = await abortable(downloaded.data.arrayBuffer(), signal);
    const files = decodeStoredProfileZip(new Uint8Array(bytes), downloaded.logId, signal);
    const embedded = requiredFile(files, 'profile-index.json', downloaded.logId);
    // 归档内索引必须与独立发布索引的大小及 SHA 相同，不允许两份索引各自有效却内容不同。
    await downloadPublishedArtifact({ download: async () => ({ data: new Blob([Uint8Array.from(embedded.bytes)]), logId: downloaded.logId }) }, result, 'profile-index.json', signal);
    const data = openProfileFiles(files, result.result, downloaded.logId, signal);
    return { data, logId: downloaded.logId };
  } catch (error) {
    if (error instanceof ApiError && error.kind === 'cancelled' && error.logId === null) throw new ApiError(error.kind, error.code, error.message, error.status, downloaded.logId, error.retryAfter);
    throw error;
  }
}
