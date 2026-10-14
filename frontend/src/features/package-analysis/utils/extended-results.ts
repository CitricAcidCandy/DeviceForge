import {
  decodeArtifactEnvelope,
  decodeEmptyArtifactResult,
  invalidBusinessResult,
  jsonObject,
  naturalNumber,
  onlyKeys,
  requireArtifactNames,
} from '../../../shared/jobs/index.ts';
import type { PublishedResult } from '../../../shared/jobs/index.ts';
import { isDeviceSpec, isSdkRule } from './extended-rules.ts';
import type { NormalizedScanInput, NormalizedSplitsInput } from './extended-rules.ts';
import { maximumPackageSize } from './rules.ts';
import type {
  PackageBuildInput,
  PackageBuildResult,
  PackageBuildValue,
  PackageDecodedResult,
  PackageDecodedValue,
  PackageDeviceSpec,
  PackageSdkScan,
  PackageSplitsResult,
  PackageSplitsValue,
} from '../types/extended.ts';

const moduleName = '包分析';
function published<T>(
  value: unknown,
  logId: string | null,
  filename: string,
  guard: (result: unknown) => result is T,
): PublishedResult<T> {
  const envelope = decodeArtifactEnvelope(value, moduleName, logId);
  requireArtifactNames(envelope, [filename], moduleName, logId);
  const artifact = envelope.artifacts[0];
  if (
    !guard(envelope.result) ||
    !artifact ||
    artifact.media_type !== 'application/zip' ||
    artifact.size > maximumPackageSize
  )
    throw invalidBusinessResult(moduleName, logId);
  return { result: structuredClone(envelope.result), artifacts: envelope.artifacts };
}
function isBuild(value: unknown): value is PackageBuildValue {
  return (
    jsonObject(value) &&
    onlyKeys(value, ['mode', 'apk_count', 'universal_entry']) &&
    (value.mode === 'default' || value.mode === 'universal') &&
    naturalNumber(value.apk_count) &&
    value.apk_count >= 1 &&
    value.apk_count <= 10000 &&
    (value.universal_entry === null || value.universal_entry === 'universal.apk') &&
    (value.mode !== 'universal' ||
      (value.apk_count === 1 && value.universal_entry === 'universal.apk'))
  );
}
export function decodeBuild(
  value: unknown,
  logId: string | null,
  input: PackageBuildInput,
): PackageBuildResult {
  const output = published(value, logId, 'built.apks', isBuild);
  if (output.result.mode !== input.mode) throw invalidBusinessResult(moduleName, logId);
  return output;
}
function isDecoded(value: unknown): value is PackageDecodedValue {
  return (
    jsonObject(value) &&
    onlyKeys(value, ['files', 'unpacked_size']) &&
    naturalNumber(value.files) &&
    value.files >= 2 &&
    value.files <= 10000 &&
    naturalNumber(value.unpacked_size) &&
    value.unpacked_size <= maximumPackageSize
  );
}
export function decodeDecoded(value: unknown, logId: string | null): PackageDecodedResult {
  return published(value, logId, 'decoded.zip', isDecoded);
}
function safeRelativePath(value: string): boolean {
  return (
    !/[\\:\u0000-\u001f\u007f-\u009f]/u.test(value) &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}
function isFinding(value: unknown): value is PackageSdkScan['findings'][number] {
  return (
    jsonObject(value) &&
    onlyKeys(value, ['rule', 'package_found', 'class_found', 'evidence']) &&
    isSdkRule(value.rule) &&
    Object.hasOwn(value.rule, 'class_name') &&
    typeof value.package_found === 'boolean' &&
    (value.class_found === null || typeof value.class_found === 'boolean') &&
    Array.isArray(value.evidence) &&
    value.evidence.length <= 10 &&
    value.evidence.every((path: unknown) => typeof path === 'string' && safeRelativePath(path)) &&
    new Set(value.evidence).size === value.evidence.length
  );
}
function isScan(value: unknown): value is PackageSdkScan {
  return (
    jsonObject(value) &&
    onlyKeys(value, ['artifact_id', 'findings']) &&
    typeof value.artifact_id === 'string' &&
    Array.isArray(value.findings) &&
    value.findings.every(isFinding)
  );
}
function evidenceRelative(path: string): string | null {
  const slash = path.indexOf('/');
  if (slash < 0) return null;
  const root = path.slice(0, slash);
  if (root !== 'smali') {
    if (!/^smali_classes[0-9]+$/.test(root)) return null;
    const number = Number(root.slice('smali_classes'.length));
    if (!Number.isSafeInteger(number) || number < 2 || number > 4294967295) return null;
  }
  return path.slice(slash + 1);
}
export function decodeScan(
  value: unknown,
  logId: string | null,
  input: NormalizedScanInput,
): PackageSdkScan {
  const result = decodeEmptyArtifactResult(value, moduleName, logId);
  if (
    !isScan(result) ||
    result.artifact_id !== input.artifact_id ||
    result.findings.length !== input.rules.length
  )
    throw invalidBusinessResult(moduleName, logId);
  for (const [index, finding] of result.findings.entries()) {
    const rule = input.rules[index];
    if (
      !rule ||
      finding.rule.name !== rule.name ||
      finding.rule.package_path !== rule.package_path ||
      finding.rule.class_name !== (rule.class_name ?? null)
    )
      throw invalidBusinessResult(moduleName, logId);
    const prefix = rule.package_path.replaceAll('.', '/') + '/';
    const relative = finding.evidence.map(evidenceRelative);
    if (
      relative.some(
        (path) => path === null || !path.startsWith(prefix) || !path.endsWith('.smali'),
      ) ||
      finding.package_found !== finding.evidence.length > 0 ||
      (rule.class_name == null
        ? finding.class_found !== null
        : finding.class_found !==
          relative.some((path) => path === prefix + rule.class_name + '.smali'))
    )
      throw invalidBusinessResult(moduleName, logId);
  }
  return structuredClone(result);
}
function sameSpec(left: PackageDeviceSpec, right: PackageDeviceSpec): boolean {
  const sameList = (first: readonly string[], second: readonly string[]) =>
    first.length === second.length && first.every((entry, index) => entry === second[index]);
  return (
    left.screen_density === right.screen_density &&
    left.sdk_version === right.sdk_version &&
    sameList(left.supported_abis, right.supported_abis) &&
    sameList(left.supported_locales, right.supported_locales) &&
    sameList(left.device_features ?? [], right.device_features ?? []) &&
    sameList(left.gl_extensions ?? [], right.gl_extensions ?? []) &&
    (left.codename ?? null) === (right.codename ?? null) &&
    (left.device_tier ?? null) === (right.device_tier ?? null)
  );
}
function isSplits(value: unknown): value is PackageSplitsValue {
  return (
    jsonObject(value) &&
    onlyKeys(value, ['device_spec', 'apk_entries']) &&
    isDeviceSpec(value.device_spec) &&
    Array.isArray(value.apk_entries) &&
    value.apk_entries.length >= 1 &&
    value.apk_entries.length <= 1000 &&
    value.apk_entries.every(
      (entry: unknown) =>
        typeof entry === 'string' && entry.endsWith('.apk') && safeRelativePath(entry),
    ) &&
    new Set(value.apk_entries).size === value.apk_entries.length
  );
}
export function decodeSplits(
  value: unknown,
  logId: string | null,
  input: NormalizedSplitsInput,
): PackageSplitsResult {
  const output = published(value, logId, 'selected-apks.zip', isSplits);
  if (!sameSpec(output.result.device_spec, input.device_spec))
    throw invalidBusinessResult(moduleName, logId);
  return output;
}
