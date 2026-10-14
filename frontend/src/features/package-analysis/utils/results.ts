import {
  decodeArtifactEnvelope,
  decodeEmptyArtifactResult,
  invalidBusinessResult,
  jsonObject,
  naturalNumber,
  onlyKeys,
  requireArtifactNames,
} from '../../../shared/jobs/index.ts';
import { maximumPackageSize } from './rules.ts';
import type {
  PackageExtractInput,
  PackageExtractResult,
  PackageManifest,
  PackageManifestInput,
  PackageSignature,
} from '../types/index.ts';

const moduleName = '包分析';
const nullableText = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';
const stringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry: unknown) => typeof entry === 'string');
function isManifest(value: unknown): value is PackageManifest {
  return (
    jsonObject(value) &&
    onlyKeys(value, [
      'artifact_id',
      'format',
      'module',
      'package_name',
      'version_code',
      'version_name',
      'min_sdk',
      'target_sdk',
      'application_label',
      'debuggable',
      'permissions',
      'xml',
    ]) &&
    typeof value.artifact_id === 'string' &&
    (value.format === 'apk' || value.format === 'aab') &&
    nullableText(value.module) &&
    typeof value.package_name === 'string' &&
    value.package_name.length > 0 &&
    nullableText(value.version_code) &&
    nullableText(value.version_name) &&
    nullableText(value.min_sdk) &&
    nullableText(value.target_sdk) &&
    nullableText(value.application_label) &&
    (value.debuggable === null || typeof value.debuggable === 'boolean') &&
    stringArray(value.permissions) &&
    typeof value.xml === 'string'
  );
}
export function decodeManifest(
  value: unknown,
  logId: string | null,
  input: PackageManifestInput,
): PackageManifest {
  const result = decodeEmptyArtifactResult(value, moduleName, logId);
  if (
    !isManifest(result) ||
    result.artifact_id !== input.artifact_id ||
    (result.format === 'apk'
      ? result.module !== null || input.module !== undefined
      : result.module !== (input.module ?? 'base'))
  ) {
    throw invalidBusinessResult(moduleName, logId);
  }
  return structuredClone(result);
}
function isSignature(value: unknown): value is PackageSignature {
  if (
    !jsonObject(value) ||
    !onlyKeys(value, ['artifact_id', 'verified', 'signers', 'schemes', 'report']) ||
    typeof value.artifact_id !== 'string' ||
    value.verified !== true ||
    typeof value.report !== 'string' ||
    !Array.isArray(value.signers) ||
    value.signers.length < 1 ||
    value.signers.length > 32 ||
    !value.signers.every(
      (signer: unknown, index: number) =>
        jsonObject(signer) &&
        onlyKeys(signer, ['number', 'distinguished_name', 'certificate_sha256']) &&
        signer.number === index + 1 &&
        nullableText(signer.distinguished_name) &&
        typeof signer.certificate_sha256 === 'string' &&
        /^[0-9a-f]{64}$/i.test(signer.certificate_sha256),
    ) ||
    !Array.isArray(value.schemes) ||
    !value.schemes.every(
      (scheme: unknown) =>
        jsonObject(scheme) &&
        onlyKeys(scheme, ['scheme', 'verified']) &&
        typeof scheme.scheme === 'string' &&
        scheme.scheme.length > 0 &&
        typeof scheme.verified === 'boolean',
    )
  )
    return false;
  const names = value.schemes.map((scheme) => (jsonObject(scheme) ? scheme.scheme : null));
  return (
    new Set(names).size === names.length &&
    value.schemes.some((scheme) => jsonObject(scheme) && scheme.verified === true)
  );
}
export function decodeSignature(
  value: unknown,
  logId: string | null,
  input: { readonly artifact_id: string },
): PackageSignature {
  const result = decodeEmptyArtifactResult(value, moduleName, logId);
  if (!isSignature(result) || result.artifact_id !== input.artifact_id)
    throw invalidBusinessResult(moduleName, logId);
  return structuredClone(result);
}
export function decodeExtract(
  value: unknown,
  logId: string | null,
  input: PackageExtractInput,
): PackageExtractResult {
  const envelope = decodeArtifactEnvelope(value, moduleName, logId);
  requireArtifactNames(envelope, ['extracted.apk'], moduleName, logId);
  const result = envelope.result;
  const artifact = envelope.artifacts[0];
  if (
    !jsonObject(result) ||
    !onlyKeys(result, ['entry']) ||
    result.entry !== input.entry ||
    !artifact ||
    artifact.media_type !== 'application/zip' ||
    !naturalNumber(artifact.size) ||
    artifact.size > maximumPackageSize
  ) {
    throw invalidBusinessResult(moduleName, logId);
  }
  return { result: { entry: input.entry }, artifacts: envelope.artifacts };
}
