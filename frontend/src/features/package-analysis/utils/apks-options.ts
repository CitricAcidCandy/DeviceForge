import { ApiError } from '../../../services/api/index.ts';
import { jsonObject, onlyKeys } from '../../../shared/jobs/index.ts';
import { normalizeArtifact } from './rules.ts';
import type { PackageApksInstallInput, PackageApksSelection } from '../types/extended.ts';

export type NormalizedApksSelection = { readonly modules?: string[] | null; readonly instant?: boolean };
const invalid = () => new ApiError('protocol', 'invalid_apks_selection', 'APKS模块须唯一有界，ALL只能单选，instant仅用于提取');
export function validApksModules(value: unknown): value is string[] | null | undefined {
  return value === undefined || value === null || Array.isArray(value) && value.length >= 1 && value.length <= 128
    && value.every((module: unknown) => typeof module === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(module))
    && new Set(value).size === value.length && (!value.includes('ALL') || value.length === 1);
}
function freeze(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}
export function freezeApksCopy<T>(value: T): T { const copy = structuredClone(value); freeze(copy); return copy; }
export function copyApksSelection(input: PackageApksSelection): NormalizedApksSelection {
  if (!validApksModules(input.modules) || input.instant !== undefined && typeof input.instant !== 'boolean') throw invalid();
  return freezeApksCopy({ ...(input.modules === undefined ? {} : { modules: input.modules === null ? null : [...input.modules] }), ...(input.instant === undefined ? {} : { instant: input.instant }) });
}
export function prepareApksInstallInput(input: PackageApksInstallInput) {
  if (!jsonObject(input) || !onlyKeys(input, ['artifact_id', 'modules']) || !validApksModules(input.modules)) throw invalid();
  return freezeApksCopy({ ...normalizeArtifact({ artifact_id: input.artifact_id }), ...(input.modules === undefined ? {} : { modules: input.modules === null ? null : [...input.modules] }) });
}
