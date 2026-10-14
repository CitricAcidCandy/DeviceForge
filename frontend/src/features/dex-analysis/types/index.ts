import type { ApiError, ApiResult, OperationDto } from '../../../services/api/index.ts';

export type DexArtifactInput = { readonly artifact_id: string };
export type DexSdkRule = {
  readonly name: string;
  readonly package_path: string;
  readonly class_name?: string | null;
};
export type DexScanInput = DexArtifactInput & { readonly rules: readonly DexSdkRule[] };
export type DexVersion = '035' | '037' | '038' | '039' | '040';
export type DexCounts = {
  readonly strings: number;
  readonly types: number;
  readonly prototypes: number;
  readonly fields: number;
  readonly methods: number;
  readonly defined_classes: number;
};
export type DexIntegrity = {
  readonly artifact_sha256: true;
  readonly dex_sha1: true;
  readonly dex_adler32: true;
};
export type DexInspection = DexArtifactInput & {
  readonly version: DexVersion;
  readonly file_size: number;
  readonly counts: DexCounts;
  readonly integrity: DexIntegrity;
};
export type DexFinding = {
  readonly rule: Readonly<Required<DexSdkRule>>;
  readonly package_found: boolean;
  readonly class_found: boolean | null;
  readonly evidence: readonly string[];
};
export type DexScanResult = DexInspection & { readonly findings: readonly DexFinding[] };
export interface DexOperationReader {
  readonly list: (signal: AbortSignal) => Promise<ApiResult<readonly OperationDto[]>>;
}
export interface DexCatalogSnapshot {
  readonly operations: readonly Readonly<OperationDto>[];
  readonly refreshing: boolean;
  readonly logId: string | null;
  readonly error: ApiError | null;
}
