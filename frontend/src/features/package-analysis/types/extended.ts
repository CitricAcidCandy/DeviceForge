import type { components } from '../../../services/api/generated.ts';
import type { PublishedResult } from '../../../shared/jobs/index.ts';
import type { PackageArtifactInput } from './index.ts';

export type PackageBuildInput = Readonly<components['schemas']['BuildApksRequest']>;
export type PackageBuildValue = Readonly<
  Required<Pick<components['schemas']['BuiltApks'], 'mode' | 'apk_count' | 'universal_entry'>>
>;
export type PackageBuildResult = PublishedResult<PackageBuildValue>;
export type PackageDecodedValue = Readonly<
  Pick<components['schemas']['DecodedPackage'], 'files' | 'unpacked_size'>
>;
export type PackageDecodedResult = PublishedResult<PackageDecodedValue>;
export type PackageSdkRule = Readonly<components['schemas']['SdkScan']['findings'][number]['rule']>;
export type PackageScanInput = PackageArtifactInput & { readonly rules: readonly PackageSdkRule[] };
export type PackageSdkScan = Readonly<components['schemas']['SdkScan']>;
export type PackageDeviceSpec = Readonly<
  Omit<
    components['schemas']['ExtractedSplits']['device_spec'],
    'supported_abis' | 'supported_locales'
  >
> & {
  readonly supported_abis: readonly string[];
  readonly supported_locales: readonly string[];
  readonly device_features?: readonly string[];
  readonly gl_extensions?: readonly string[];
  readonly codename?: string | null;
  readonly device_tier?: string | null;
};
export type PackageApksSelection = {
  readonly modules?: readonly string[] | null;
  readonly instant?: boolean;
};
export type PackageApksInstallInput = PackageArtifactInput & Pick<PackageApksSelection, 'modules'>;
export type PackageSplitsInput = PackageArtifactInput &
  PackageApksSelection & { readonly device_spec: PackageDeviceSpec };
export type PackageSplitsValue = Readonly<
  Pick<components['schemas']['ExtractedSplits'], 'apk_entries'>
> & { readonly device_spec: PackageDeviceSpec };
export type PackageSplitsResult = PublishedResult<PackageSplitsValue>;
