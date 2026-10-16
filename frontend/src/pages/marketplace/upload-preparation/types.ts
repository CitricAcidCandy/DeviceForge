import type { MarketplaceKind, MarketplacePublishEntry } from '../../../features/marketplace/index.ts';

export interface UploadInputFile { readonly path: string; readonly file: File }
export interface UploadSelection {
  readonly mode: 'file' | 'directory' | 'archive';
  readonly name: string;
  readonly files: readonly UploadInputFile[];
}
export interface ArchiveFile { readonly path: string; readonly bytes: Uint8Array; readonly mode?: number }
export interface UploadInspection {
  readonly files: readonly { readonly path: string; readonly size: number }[];
  readonly excluded: readonly string[];
  readonly totalSize: number;
  readonly metadata: MarketplacePublishEntry | null;
  readonly identity: { readonly id: string; readonly version: string; readonly kind: 'server' | 'browser' } | null;
}
export interface PreparedUpload {
  readonly file: File;
  readonly sha256: string;
  readonly inspection: UploadInspection;
}
export interface PreparationRequest {
  readonly selection: UploadSelection;
  readonly kind: MarketplaceKind;
  readonly metadata?: MarketplacePublishEntry;
}
export type PreparationResponse =
  | { readonly ok: true; readonly result: UploadInspection | PreparedUpload }
  | { readonly ok: false; readonly error: string };
