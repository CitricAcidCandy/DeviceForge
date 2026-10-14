import { isRecord } from '../../../services/api/validation.ts';
import {
  decodeEmptyArtifactResult,
  invalidBusinessResult,
  nonemptyText,
  onlyKeys,
} from '../../../shared/jobs/index.ts';
import { runtimeFeatureKey } from './feature-rules.ts';
import { isToolModule } from './results.ts';
import { toolModuleId, toolVersion } from './rules.ts';
import { decodeManifestSource, hasManifestSource, manifestSourceKeys } from './source-result.ts';
import type {
  ToolInstallation,
  ToolModule,
  ToolRuntimeFeaturePreparation,
  ToolRuntimeFeatureStatus,
} from '../types/index.ts';

function featureModules(value: unknown, featureKey: string): value is ToolModule[] {
  return (
    Array.isArray(value) &&
    value.length <= 128 &&
    value.every(
      (module: unknown) =>
        isRecord(module) &&
        onlyKeys(module, [
          'module_id',
          'kind',
          'required',
          'feature_key',
          'available_version',
          'installed_version',
          'entry_present',
          'action',
          'size',
        ]) &&
        isToolModule(module) &&
        module.kind === 'runtime' &&
        module.feature_key === featureKey &&
        module.action !== 'local_only',
    ) &&
    new Set(value.filter(isToolModule).map((module) => module.module_id)).size === value.length
  );
}
function isFeatureInstallation(value: unknown): value is ToolInstallation {
  return (
    isRecord(value) &&
    onlyKeys(value, ['module_id', 'version', 'sha256', 'changed']) &&
    toolModuleId(value.module_id) &&
    toolVersion(value.version) &&
    typeof value.changed === 'boolean' &&
    typeof value.sha256 === 'string' &&
    /^[0-9a-f]{64}$/i.test(value.sha256)
  );
}
function featureInstallations(value: unknown): value is ToolInstallation[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 128 &&
    value.every(isFeatureInstallation) &&
    new Set(value.filter(isFeatureInstallation).map((module) => module.module_id)).size ===
      value.length
  );
}
export function decodeRuntimeFeatureStatus(
  raw: unknown,
  logId: string | null,
  featureKey: string,
): ToolRuntimeFeatureStatus {
  const value = decodeEmptyArtifactResult(raw, '工具运行时功能', logId);
  if (
    !isRecord(value) ||
    !onlyKeys(value, ['feature_key', 'found', 'ready', 'modules', ...manifestSourceKeys]) ||
    !runtimeFeatureKey(value.feature_key) ||
    value.feature_key !== featureKey ||
    !(value.manifest_version === null || nonemptyText(value.manifest_version)) ||
    !(value.source_error === null || nonemptyText(value.source_error)) ||
    typeof value.found !== 'boolean' ||
    typeof value.ready !== 'boolean' ||
    !featureModules(value.modules, featureKey)
  ) {
    throw invalidBusinessResult('工具运行时功能', logId);
  }
  const source = decodeManifestSource(value, logId, '工具运行时功能', true);
  if (
    (source === null && (value.manifest_version === null) !== (value.source_error !== null)) ||
    (value.manifest_version === null && value.modules.length !== 0) ||
    value.found !== value.modules.length > 0 ||
    value.ready !==
      (value.found &&
        value.modules.every((module) => module.action === 'current' && module.entry_present))
  ) {
    throw invalidBusinessResult('工具运行时功能', logId);
  }
  return {
    feature_key: value.feature_key,
    manifest_version: value.manifest_version,
    source_error: value.source_error,
    found: value.found,
    ready: value.ready,
    modules: value.modules,
    ...(source ?? {}),
  };
}
export function decodeRuntimeFeaturePreparation(
  raw: unknown,
  logId: string | null,
  featureKey: string,
): ToolRuntimeFeaturePreparation {
  const value = decodeEmptyArtifactResult(raw, '工具运行时功能', logId);
  if (
    !isRecord(value) ||
    !onlyKeys(
      value,
      hasManifestSource(value)
        ? ['feature_key', 'ready', 'modules', ...manifestSourceKeys]
        : ['feature_key', 'manifest_version', 'ready', 'modules'],
    ) ||
    !runtimeFeatureKey(value.feature_key) ||
    value.feature_key !== featureKey ||
    !nonemptyText(value.manifest_version) ||
    value.ready !== true ||
    !featureInstallations(value.modules)
  )
    throw invalidBusinessResult('工具运行时功能', logId);
  const source = decodeManifestSource(value, logId, '工具运行时功能');
  return {
    feature_key: value.feature_key,
    manifest_version: value.manifest_version,
    ready: value.ready,
    modules: value.modules,
    ...(source ?? {}),
  };
}
