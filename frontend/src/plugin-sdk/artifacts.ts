import type { HostResult } from './models.ts';

// 独立公开模型；产物身份与原字节传输不暴露宿主路径或凭据。
export interface Artifact {
  readonly id: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly size: number;
  readonly sha256: string;
  readonly createdAt: number;
}
export interface ArtifactAccess {
  readonly upload: (filename: string, content: Blob, signal: AbortSignal) => Promise<HostResult<Artifact>>;
  readonly download: (id: string, signal: AbortSignal) => Promise<HostResult<Blob>>;
}
