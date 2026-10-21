export type ToolSupplyAction =
  | 'catalog'
  | 'plan'
  | 'install'
  | 'import'
  | 'remove'
  | 'runtime_feature.status'
  | 'runtime_feature.prepare';
export type ToolSupplyDecision =
  | 'install'
  | 'update'
  | 'repair'
  | 'current'
  | 'local_newer'
  | 'local_only';
export interface ToolManifestSource {
  readonly manifest_source?: 'live' | 'cache' | null;
  readonly manifest_sha256?: string | null;
}
export interface ToolModule {
  readonly module_id: string;
  readonly kind: 'tool' | 'runtime';
  readonly required?: boolean;
  readonly feature_key: string | null;
  readonly available_version: string | null;
  readonly installed_version: string | null;
  readonly entry_present: boolean;
  readonly action: ToolSupplyDecision;
  readonly size?: number;
}
export interface ToolCatalog extends ToolManifestSource {
  readonly manifest_version: string | null;
  readonly source_error: string | null;
  readonly modules: readonly ToolModule[];
}
export interface ToolPlan extends ToolManifestSource {
  readonly manifest_version: string;
  readonly source_error?: string | null;
  readonly download_bytes: number;
  readonly modules: readonly ToolModule[];
}
export interface ToolInstallation {
  readonly module_id: string;
  readonly version: string;
  readonly changed: boolean;
  readonly sha256: string;
}
export interface ToolLocalImport {
  readonly archive_artifact_id: string;
  readonly module_id: string;
  readonly manifest: import('../../../shared/jobs/index.ts').JsonData;
}
export interface ToolInstallResult extends ToolInstallation, ToolManifestSource {
  readonly manifest_version?: string;
  readonly source_error?: string | null;
}
export interface ToolRemoval {
  readonly module_id: string;
  readonly removed: boolean;
  readonly version?: string;
}
export interface ToolRuntimeFeatureStatus extends ToolManifestSource {
  readonly feature_key: string;
  readonly manifest_version: string | null;
  readonly source_error: string | null;
  readonly found: boolean;
  readonly ready: boolean;
  readonly modules: readonly ToolModule[];
}
export interface ToolRuntimeFeaturePreparation extends ToolManifestSource {
  readonly feature_key: string;
  readonly manifest_version: string;
  readonly source_error?: string | null;
  readonly ready: true;
  readonly modules: readonly ToolInstallation[];
}
