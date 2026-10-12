import type { ApiResult, ArtifactDto } from '../api/index.ts';
import { ApiError } from '../api/errors.ts';
import { abortable } from '../api/abort.ts';
import { isRecord } from '../api/validation.ts';
import { invalidBusinessResult, naturalNumber, nonemptyText, onlyKeys } from './values.ts';

export interface ArtifactEnvelope { readonly result: unknown; readonly artifacts: readonly ArtifactDto[] }
export interface PublishedResult<T> { readonly result: T; readonly artifacts: readonly ArtifactDto[] }
export interface ArtifactReader { readonly download: (id: string, signal: AbortSignal) => Promise<ApiResult<Blob>> }
export function isTaskArtifact(value: unknown): value is ArtifactDto {
  return isRecord(value) && nonemptyText(value.id) && nonemptyText(value.filename) && nonemptyText(value.media_type)
    && naturalNumber(value.size) && naturalNumber(value.created_at) && typeof value.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(value.sha256);
}
export function decodeArtifactEnvelope(value: unknown, module: string, logId: string | null): ArtifactEnvelope {
  if (!isRecord(value) || !onlyKeys(value, ['result', 'artifacts']) || !Object.hasOwn(value, 'result')
    || !Array.isArray(value.artifacts) || !value.artifacts.every(isTaskArtifact)) throw invalidBusinessResult(module, logId);
  const artifacts = value.artifacts.filter(isTaskArtifact);
  if (new Set(artifacts.map((artifact) => artifact.id)).size !== artifacts.length || new Set(artifacts.map((artifact) => artifact.filename)).size !== artifacts.length) throw invalidBusinessResult(module, logId);
  return { result: value.result, artifacts };
}
export function decodeEmptyArtifactResult(value: unknown, module: string, logId: string | null): unknown {
  const envelope = decodeArtifactEnvelope(value, module, logId);
  if (envelope.artifacts.length !== 0) throw invalidBusinessResult(module, logId);
  return envelope.result;
}
export function requireArtifactNames(envelope: ArtifactEnvelope, names: readonly string[], module: string, logId: string | null): void {
  if (envelope.artifacts.length !== names.length || !names.every((name) => envelope.artifacts.some((artifact) => artifact.filename === name))) throw invalidBusinessResult(module, logId);
}
// 下载产物原字节，并按已发布元数据核对大小和摘要；日志 ID 随下载保留。
export async function downloadPublishedArtifact<T>(reader: ArtifactReader, result: PublishedResult<T>, filename: string, signal: AbortSignal): Promise<ApiResult<Blob>> {
  if (signal.aborted) throw new ApiError('cancelled', 'cancelled', '产物下载等待已取消');
  const artifact = result.artifacts.find((item) => item.filename === filename);
  if (!artifact || !isTaskArtifact(artifact)) throw new ApiError('protocol', 'missing_artifact', '结果中没有有效的指定产物');
  const downloaded = await abortable(reader.download(artifact.id, signal), signal);
  try {
    if (signal.aborted) throw new ApiError('cancelled', 'cancelled', '产物下载等待已取消');
    if (downloaded.data.size !== artifact.size) throw new ApiError('protocol', 'artifact_size_mismatch', '产物字节数与元数据不一致', null, downloaded.logId);
    const bytes = await abortable(downloaded.data.arrayBuffer(), signal);
    const hash = await abortable(crypto.subtle.digest('SHA-256', bytes), signal);
    if (signal.aborted) throw new ApiError('cancelled', 'cancelled', '产物下载等待已取消');
    const digest = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (digest !== artifact.sha256.toLowerCase()) throw new ApiError('protocol', 'artifact_digest_mismatch', '产物摘要与元数据不一致', null, downloaded.logId);
    return downloaded;
  } catch (error) {
    // 已收到响应后撤销字节处理，仍保留该下载请求的真实日志。
    if (error instanceof ApiError && error.kind === 'cancelled' && error.logId === null) {
      throw new ApiError(error.kind, error.code, error.message, error.status, downloaded.logId, error.retryAfter);
    }
    throw error;
  }
}
