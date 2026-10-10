import type { ArtifactAccess, HostResult } from '../plugin-sdk/index.ts';

// 上传下载沿作用域调用门禁；不复制 HTTP、不创建下载 URL 或宿主资源。
export function scopedArtifactAccess(
  upstream: ArtifactAccess | undefined,
  call: <T>(request: (signal: AbortSignal) => Promise<HostResult<T>>, signal: AbortSignal) => Promise<HostResult<T>>,
): ArtifactAccess | undefined {
  if (!upstream) return undefined;
  return Object.freeze<ArtifactAccess>({
    upload: (filename, content, signal) => call((current) => upstream.upload(filename, content, current), signal),
    download: (id, signal) => call((current) => upstream.download(id, current), signal),
  });
}
