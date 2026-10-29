import type { Artifact, HostResult } from '@deviceforge/plugin-sdk';

export interface ArchiveEntry {
  readonly name: string;
  readonly size: number;
  readonly compressedSize: number;
  readonly directory: boolean;
}
export interface ArchivePage {
  readonly total: number;
  readonly nextOffset: number | null;
  readonly entries: readonly ArchiveEntry[];
}
export interface EntryQuery {
  readonly offset?: number;
  readonly limit?: number;
}
export interface FileFailure extends Error {
  readonly kind: 'http' | 'network' | 'cancelled' | 'protocol';
  readonly code: string;
  readonly status: number | null;
  readonly logId: string | null;
  readonly retryAfter: string | null;
}
export interface FileFailureConstructor {
  new (
    kind: FileFailure['kind'],
    code: string,
    message: string,
    status?: number | null,
    logId?: string | null,
    retryAfter?: string | null,
  ): FileFailure;
}

/** 网关返回未知值，由领域规则核对身份与分页，测试和远端都不能跳过校验。 */
export interface FileBrowserGateway {
  metadata(id: string, signal: AbortSignal): Promise<HostResult<unknown>>;
  entries(id: string, query: EntryQuery, signal: AbortSignal): Promise<HostResult<unknown>>;
  remove(id: string, signal: AbortSignal): Promise<HostResult<unknown>>;
  readonly upload?: (
    filename: string, content: Blob, signal: AbortSignal,
  ) => Promise<HostResult<unknown>>;
  readonly download?: (id: string, signal: AbortSignal) => Promise<HostResult<Blob>>;
}
export type ArtifactMetadataView = Readonly<Artifact>;
export type ArtifactEntriesView = Readonly<ArchivePage>;
export interface ArtifactBrowserSnapshot {
  readonly selection: string | null;
  readonly metadata: ArtifactMetadataView | null;
  readonly page: ArtifactEntriesView | null;
  readonly loading: 'metadata' | 'entries' | 'remove' | 'upload' | 'download' | null;
  readonly error: FileFailure | null;
  readonly metadataLogId: string | null;
  readonly entriesLogId: string | null;
  readonly removeLogId: string | null;
  readonly uploadLogId: string | null;
  readonly downloadLogId: string | null;
}
