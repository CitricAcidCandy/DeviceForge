import type { Artifact, HostResult } from '@deviceforge/plugin-sdk';
export interface ArtifactEnvelope {
    readonly result: unknown;
    readonly artifacts: readonly Artifact[];
}
export interface PublishedResult<T> {
    readonly result: T;
    readonly artifacts: readonly Artifact[];
}
export interface ArtifactReader {
    readonly download: (id: string, signal: AbortSignal) => Promise<HostResult<Blob>>;
}
export declare function isTaskArtifact(value: unknown): value is Artifact;
export declare function decodeArtifactEnvelope(value: unknown, module: string, logId: string | null): ArtifactEnvelope;
export declare function decodeEmptyArtifactResult(value: unknown, module: string, logId: string | null): unknown;
export declare function requireArtifactNames(envelope: ArtifactEnvelope, names: readonly string[], module: string, logId: string | null): void;
export declare function downloadPublishedArtifact<T>(reader: ArtifactReader, result: PublishedResult<T>, filename: string, signal: AbortSignal): Promise<HostResult<Blob>>;
