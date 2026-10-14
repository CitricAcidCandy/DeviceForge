import { isRecord } from '../../../shared/api/validation.ts';
import { decodeEmptyArtifactResult, invalidBusinessResult, naturalNumber, nonemptyText } from '../../../shared/jobs/index.ts';
import type { ToolCatalog, ToolInstallResult, ToolModule, ToolPlan, ToolRemoval } from './types.ts';
import { compareToolVersions, toolModuleId, toolVersion } from './rules.ts';
import { decodeManifestSource } from './source-result.ts';

export function isToolModule(value: unknown): value is ToolModule {
  if (!isRecord(value) || !toolModuleId(value.module_id) || value.kind !== 'tool' && value.kind !== 'runtime'
    || !(value.feature_key === null || nonemptyText(value.feature_key)) || !(value.available_version === null || toolVersion(value.available_version))
    || !(value.installed_version === null || toolVersion(value.installed_version)) || typeof value.entry_present !== 'boolean'
    || typeof value.action !== 'string' || !['install', 'update', 'repair', 'current', 'local_newer', 'local_only'].includes(value.action)
    || value.required !== undefined && typeof value.required !== 'boolean' || value.size !== undefined && (!naturalNumber(value.size) || value.size === 0)) return false;
  if (value.kind === 'runtime' && !nonemptyText(value.feature_key)) return false;
  if (value.action === 'local_only') return value.available_version === null && toolVersion(value.installed_version);
  if (!toolVersion(value.available_version) || typeof value.required !== 'boolean' || !naturalNumber(value.size) || value.size === 0) return false;
  if (value.installed_version === null) return value.action === 'install' && !value.entry_present;
  if (!toolVersion(value.installed_version)) return false;
  const order = compareToolVersions(value.available_version, value.installed_version);
  return order > 0 ? value.action === 'update' : order < 0 ? value.action === 'local_newer'
    : value.action === 'repair' || value.action === 'current' && value.entry_present;
}
function modules(value: unknown): value is ToolModule[] {
  return Array.isArray(value) && value.every(isToolModule) && new Set(value.filter(isToolModule).map((module) => module.module_id)).size === value.length;
}
export function decodeCatalog(raw: unknown, logId: string | null): ToolCatalog {
  const value = decodeEmptyArtifactResult(raw, '工具供应', logId);
  if (!isRecord(value) || !(value.manifest_version === null || nonemptyText(value.manifest_version))
    || !(value.source_error === null || nonemptyText(value.source_error)) || !modules(value.modules)) throw invalidBusinessResult('工具供应', logId);
  const source = decodeManifestSource(value, logId, '工具供应', true);
  if (source === null && (value.manifest_version === null) !== (value.source_error !== null)
    || value.manifest_version === null && value.modules.some((module) => module.action !== 'local_only')) throw invalidBusinessResult('工具供应', logId);
  return { manifest_version: value.manifest_version, source_error: value.source_error, modules: value.modules, ...(source ?? {}) };
}
export function decodePlan(raw: unknown, logId: string | null, selected: readonly string[] = []): ToolPlan {
  const value = decodeEmptyArtifactResult(raw, '工具供应', logId);
  if (!isRecord(value) || !nonemptyText(value.manifest_version) || !naturalNumber(value.download_bytes) || !modules(value.modules)
    || value.modules.length > 128 || value.modules.some((module) => module.action === 'local_only')
    || selected.length > 0 && (value.modules.length !== selected.length || !value.modules.every((module) => selected.includes(module.module_id)))) throw invalidBusinessResult('工具供应', logId);
  let expected = 0;
  for (const module of value.modules) {
    if (['install', 'update', 'repair'].includes(module.action)) expected += module.size ?? 0;
  }
  if (!Number.isSafeInteger(expected) || value.download_bytes !== expected) throw invalidBusinessResult('工具供应', logId);
  const source = decodeManifestSource(value, logId, '工具供应');
  return { manifest_version: value.manifest_version, download_bytes: value.download_bytes, modules: value.modules, ...(source ?? {}) };
}
export function decodeInstallation(raw: unknown, logId: string | null, moduleId: string): ToolInstallResult {
  const value = decodeEmptyArtifactResult(raw, '工具供应', logId);
  if (!isRecord(value) || value.module_id !== moduleId || !toolVersion(value.version) || typeof value.changed !== 'boolean'
    || typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(value.sha256)) throw invalidBusinessResult('工具供应', logId);
  const source = decodeManifestSource(value, logId, '工具供应');
  if (source !== null) {
    if (!nonemptyText(value.manifest_version)) throw invalidBusinessResult('工具供应', logId);
    return { module_id: moduleId, version: value.version, changed: value.changed, sha256: value.sha256,
      manifest_version: value.manifest_version, ...source };
  }
  return { module_id: moduleId, version: value.version, changed: value.changed, sha256: value.sha256 };
}
export function decodeRemoval(raw: unknown, logId: string | null, moduleId: string): ToolRemoval {
  const value = decodeEmptyArtifactResult(raw, '工具供应', logId);
  if (!isRecord(value) || value.module_id !== moduleId || typeof value.removed !== 'boolean' || value.removed && !toolVersion(value.version)
    || !value.removed && value.version !== undefined) throw invalidBusinessResult('工具供应', logId);
  return { module_id: moduleId, removed: value.removed, ...(typeof value.version === 'string' ? { version: value.version } : {}) };
}
