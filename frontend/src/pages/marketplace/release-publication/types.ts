import type { components } from '../../../services/api/generated.ts';
export type ReleaseManifest = components['schemas']['PluginReleaseManifest'];
export type ReleaseVariant = ReleaseManifest['components'][number]['variants'][number];
export type ReleaseToolVariant = ReleaseManifest['tools'][number]['variants'][number];

export interface ReleasePublicationResource {
  readonly sha256: string;
  readonly size: number;
  readonly path: string;
  readonly blob: Blob;
}

export interface ReleasePublicationPlan {
  readonly manifest: ReleaseManifest;
  readonly file: File;
  readonly resources: readonly ReleasePublicationResource[];
  readonly remoteResources?: readonly Omit<ReleasePublicationResource, 'blob'>[];
  readonly manifestSha256: string;
  readonly manifestBlob: Blob;
  readonly totalResourceBytes: number;
}

export interface ReleasePublicationProgress {
  readonly stage: 'checking' | 'uploading' | 'manifest' | 'catalog' | 'complete';
  readonly completedResources: number;
  readonly totalResources: number;
  readonly completedBytes: number;
  readonly totalBytes: number;
  readonly current?: string;
}

export interface ReleasePublicationResult {
  readonly resourceCount: number;
  readonly reusedCount: number;
  readonly manifestSha256: string;
  readonly source: string;
}
