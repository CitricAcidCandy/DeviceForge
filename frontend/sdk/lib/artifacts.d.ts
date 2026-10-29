import type { HostResult } from './models.js';
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
