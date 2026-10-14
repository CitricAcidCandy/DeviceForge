import type { components } from '../../../services/api/generated.ts';
import type { PublishedResult } from '../../../shared/jobs/index.ts';

export type PackageArtifactInput = { readonly artifact_id: string };
export type PackageManifestInput = PackageArtifactInput & { readonly module?: string };
export type PackageExtractInput = PackageArtifactInput & { readonly entry: string };
export type PackageManifest = Readonly<Required<components['schemas']['PackageManifest']>>;
export type PackageSigner = Readonly<
  Required<components['schemas']['PackageSignature']['signers'][number]>
>;
export type PackageSignature = Readonly<
  Omit<components['schemas']['PackageSignature'], 'signers'>
> & { readonly signers: readonly PackageSigner[] };
export type PackageExtractResult = PublishedResult<
  Readonly<Pick<components['schemas']['ExtractedApk'], 'entry'>>
>;
