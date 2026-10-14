import type { ApiError, ApiResult, ArchiveEntries, ArchiveEntryQuery, ArtifactDto, ArtifactMetadata } from '../../../services/api/index.ts';

export interface ArtifactBrowserGateway {
  readonly metadata: (id: string, signal: AbortSignal) => Promise<ApiResult<ArtifactMetadata>>;
  readonly entries: (id: string, query: ArchiveEntryQuery, signal: AbortSignal) => Promise<ApiResult<ArchiveEntries>>;
  readonly remove: (id: string, signal: AbortSignal) => Promise<ApiResult<ArtifactMetadata>>;
  readonly upload?: (filename: string, content: Blob, signal: AbortSignal) => Promise<ApiResult<ArtifactDto>>;
  readonly download?: (id: string, signal: AbortSignal) => Promise<ApiResult<Blob>>;
}
export type ArtifactMetadataView = Readonly<ArtifactMetadata>;
export type ArtifactEntriesView = Readonly<Omit<ArchiveEntries, 'entries'>> & { readonly entries: readonly Readonly<ArchiveEntries['entries'][number]>[] };
export interface ArtifactBrowserSnapshot {
  readonly selection: string | null;
  readonly metadata: ArtifactMetadataView | null;
  readonly page: ArtifactEntriesView | null;
  readonly loading: 'metadata' | 'entries' | 'remove' | 'upload' | 'download' | null;
  readonly error: ApiError | null;
  readonly metadataLogId: string | null;
  readonly entriesLogId: string | null;
  readonly removeLogId: string | null;
  readonly uploadLogId: string | null;
  readonly downloadLogId: string | null;
}
