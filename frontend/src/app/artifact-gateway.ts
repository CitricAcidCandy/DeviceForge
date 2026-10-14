import { HostError } from '../plugin-sdk/index.ts';
import type { Artifact, ArtifactAccess, HostResult } from '../plugin-sdk/index.ts';
import type { ApiResult, ArtifactDto } from '../services/api/index.ts';
import { publicCall } from './public-api.ts';

// 接收 runtime 已有传输端口；生成 DTO 只在宿主内部使用。
export interface ArtifactTransport {
  readonly upload: (
    filename: string,
    content: Blob,
    signal: AbortSignal,
  ) => Promise<ApiResult<ArtifactDto>>;
  readonly download: (id: string, signal: AbortSignal) => Promise<ApiResult<Blob>>;
}
export function publicArtifact(dto: ArtifactDto): Artifact {
  if (
    !dto.id.trim() ||
    !dto.filename.trim() ||
    !Number.isSafeInteger(dto.size) ||
    dto.size < 0 ||
    !/^[a-fA-F0-9]{64}$/.test(dto.sha256) ||
    !Number.isFinite(dto.created_at) ||
    dto.created_at < 0
  ) {
    throw new HostError('protocol', 'invalid_artifact', '产物元数据不符合公开契约');
  }
  return Object.freeze({
    id: dto.id,
    filename: dto.filename,
    mediaType: dto.media_type,
    size: dto.size,
    sha256: dto.sha256,
    createdAt: dto.created_at,
  });
}
export function createArtifactGateway(
  transport: ArtifactTransport,
  lifetime: AbortSignal,
): ArtifactAccess {
  async function call<T, U>(
    request: (signal: AbortSignal) => Promise<HostResult<T>>,
    map: (data: T) => U,
    caller: AbortSignal,
  ): Promise<HostResult<U>> {
    if (lifetime.aborted) throw new HostError('cancelled', 'host_closed', '产物宿主已关闭');
    const signal = AbortSignal.any([caller, lifetime]);
    if (signal.aborted) throw new HostError('cancelled', 'cancelled', '请求等待已取消');
    const result = await publicCall(request(signal), map);
    if (signal.aborted)
      throw new HostError('cancelled', 'stale_result', '产物晚到结果已撤销', result.logId);
    return result;
  }
  return Object.freeze<ArtifactAccess>({
    upload: (filename, content, signal) =>
      call((current) => transport.upload(filename, content, current), publicArtifact, signal),
    download: (id, signal) =>
      call(
        (current) => transport.download(id, current),
        (data) => data,
        signal,
      ),
  });
}
