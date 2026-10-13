import { ApiError } from '../../shared/api/index.ts';
import type { ApiResult } from '../../shared/api/index.ts';
import { abortable } from '../../shared/api/abort.ts';
import { downloadPublishedArtifact } from '../../shared/jobs/index.ts';
import type { ArtifactReader, PublishedResult } from '../../shared/jobs/index.ts';
import { decodeProfileIndex } from './index-results.ts';
import { PROFILE_LIMITS, invalidProfile } from './rules.ts';
import type { ProfileIndex, ProfileResult } from './types.ts';

function requireSize(result: PublishedResult<ProfileResult>, filename: string, maximum: number): void {
  const artifact = result.artifacts.find((item) => item.filename === filename);
  if (!artifact || artifact.size <= 0 || artifact.size > maximum) throw invalidProfile(null);
}
// 先核已发布原字节，再解析严格 UTF-8 JSON；下载日志与任务日志分别保留。
export async function downloadProfileIndex(reader: ArtifactReader, result: PublishedResult<ProfileResult>, signal: AbortSignal): Promise<ApiResult<ProfileIndex>> {
  requireSize(result, 'profile-index.json', PROFILE_LIMITS.indexBytes);
  const downloaded = await downloadPublishedArtifact(reader, result, 'profile-index.json', signal);
  try {
    const bytes = await abortable(downloaded.data.arrayBuffer(), signal);
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw invalidProfile(downloaded.logId); }
    const data = decodeProfileIndex(value, result.result, downloaded.logId);
    if (signal.aborted) throw new ApiError('cancelled', 'cancelled', '索引解析等待已取消', null, downloaded.logId);
    return { data, logId: downloaded.logId };
  } catch (error) {
    if (error instanceof ApiError && error.kind === 'cancelled' && error.logId === null) throw new ApiError(error.kind, error.code, error.message, error.status, downloaded.logId, error.retryAfter);
    throw error;
  }
}
export async function downloadProfileArchive(reader: ArtifactReader, result: PublishedResult<ProfileResult>, signal: AbortSignal): Promise<ApiResult<Blob>> {
  requireSize(result, 'profile.zip', PROFILE_LIMITS.archiveBytes);
  return downloadPublishedArtifact(reader, result, 'profile.zip', signal);
}
