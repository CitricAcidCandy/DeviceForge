import { ApiError } from '../../../shared/api/index.ts';
import { jsonObject, naturalNumber, onlyKeys } from '../../../shared/jobs/index.ts';
import type { PackageBuildInput, PackageDeviceSpec, PackageScanInput, PackageSdkRule, PackageSplitsInput } from '../types/extended.ts';
import { normalizeArtifact } from './rules.ts';
import { copyApksSelection, freezeApksCopy } from './apks-options.ts';
import type { NormalizedApksSelection } from './apks-options.ts';

export type NormalizedScanInput = { readonly artifact_id: string; readonly rules: PackageSdkRule[] };
export type NormalizedSplitsInput = NormalizedApksSelection & {
  readonly artifact_id: string;
  readonly device_spec: Omit<PackageDeviceSpec, 'supported_abis' | 'supported_locales' | 'device_features' | 'gl_extensions'> & {
    readonly supported_abis: string[];
    readonly supported_locales: string[];
    readonly device_features?: string[];
    readonly gl_extensions?: string[];
  };
};
const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const packagePath = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;
function invalidInput(): ApiError {
  return new ApiError('protocol', 'invalid_package_input', '包分析输入与构建模式、SDK规则或设备规格契约不兼容');
}
export function normalizeBuild(input: PackageBuildInput): PackageBuildInput {
  if (!jsonObject(input) || !onlyKeys(input, ['artifact_id', 'mode']) || (input.mode !== 'default' && input.mode !== 'universal')) throw invalidInput();
  return { ...normalizeArtifact({ artifact_id: input.artifact_id }), mode: input.mode };
}
export function isSdkRule(value: unknown): value is PackageSdkRule {
  return jsonObject(value) && onlyKeys(value, ['name', 'package_path', 'class_name'])
    && typeof value.name === 'string' && /\P{White_Space}/u.test(value.name) && new TextEncoder().encode(value.name).length <= 100
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value.name)
    && typeof value.package_path === 'string' && value.package_path.length <= 200 && packagePath.test(value.package_path)
    && (!Object.hasOwn(value, 'class_name') || value.class_name === null
      || typeof value.class_name === 'string' && value.class_name.length <= 100 && identifier.test(value.class_name));
}
export function normalizeScan(input: PackageScanInput): NormalizedScanInput {
  if (!jsonObject(input) || !onlyKeys(input, ['artifact_id', 'rules']) || !Array.isArray(input.rules)
    || input.rules.length < 1 || input.rules.length > 100 || !input.rules.every(isSdkRule)) throw invalidInput();
  const rules = input.rules.filter(isSdkRule).map((rule) => structuredClone(rule));
  if (new Set(rules.map((rule) => rule.name)).size !== rules.length) throw invalidInput();
  return { ...normalizeArtifact({ artifact_id: input.artifact_id }), rules };
}
function tokenArray(value: unknown, maximum: number, minimum = 1, pattern = /^[A-Za-z0-9_-]{1,80}$/): value is string[] {
  return Array.isArray(value) && value.length >= minimum && value.length <= maximum && new Set(value).size === value.length
    && value.every((entry: unknown) => typeof entry === 'string' && pattern.test(entry));
}
function optionalFeatureArray(value: unknown): value is string[] | undefined {
  return value === undefined || tokenArray(value, 256, 0, /^[A-Za-z0-9_.:-]{1,160}$/);
}
function optionalSpecToken(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
}
export function isDeviceSpec(value: unknown): value is PackageDeviceSpec {
  if (!jsonObject(value) || !onlyKeys(value, ['supported_abis', 'supported_locales', 'screen_density', 'sdk_version', 'device_features', 'gl_extensions', 'codename', 'device_tier'])
    || !tokenArray(value.supported_abis, 16) || !tokenArray(value.supported_locales, 100)
    || !naturalNumber(value.screen_density) || value.screen_density < 1 || value.screen_density > 10000
    || !naturalNumber(value.sdk_version) || value.sdk_version < 1 || value.sdk_version > 10000
    || !optionalFeatureArray(value.device_features) || !optionalFeatureArray(value.gl_extensions)
    || !optionalSpecToken(value.codename) || !optionalSpecToken(value.device_tier)) return false;
  const bytes = [...value.supported_abis, ...value.supported_locales, ...(value.device_features ?? []), ...(value.gl_extensions ?? [])].reduce((sum, token) => sum + token.length, 0)
    + (value.codename?.length ?? 0) + (value.device_tier?.length ?? 0);
  return bytes <= 48 * 1024;
}
export function normalizeSplits(input: PackageSplitsInput): NormalizedSplitsInput {
  if (!jsonObject(input) || !onlyKeys(input, ['artifact_id', 'device_spec', 'modules', 'instant']) || !isDeviceSpec(input.device_spec)) throw invalidInput();
  return freezeApksCopy({
    ...normalizeArtifact({ artifact_id: input.artifact_id }),
    ...copyApksSelection(input),
    device_spec: {
      supported_abis: [...input.device_spec.supported_abis], supported_locales: [...input.device_spec.supported_locales], screen_density: input.device_spec.screen_density, sdk_version: input.device_spec.sdk_version,
      ...(input.device_spec.device_features === undefined ? {} : { device_features: [...input.device_spec.device_features] }),
      ...(input.device_spec.gl_extensions === undefined ? {} : { gl_extensions: [...input.device_spec.gl_extensions] }),
      ...(input.device_spec.codename === undefined ? {} : { codename: input.device_spec.codename }),
      ...(input.device_spec.device_tier === undefined ? {} : { device_tier: input.device_spec.device_tier }),
    },
  });
}
