import { ApiError } from '../../shared/api/index.ts';
import { jsonObject, onlyKeys } from '../../shared/jobs/index.ts';
import type { PackageArtifactInput, PackageExtractInput, PackageManifestInput } from './types.ts';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const modulePattern = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;
export const maximumPackageSize = 64 * 1024 * 1024;
function invalidInput(): ApiError {
  return new ApiError('protocol', 'invalid_package_input', '包分析输入与公开产物、模块或精确条目契约不兼容');
}
function artifactId(value: unknown): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw invalidInput();
  return value.toLowerCase();
}
export function normalizeArtifact(input: PackageArtifactInput): PackageArtifactInput {
  if (!jsonObject(input) || !onlyKeys(input, ['artifact_id'])) throw invalidInput();
  return { artifact_id: artifactId(input.artifact_id) };
}
export function normalizeManifest(input: PackageManifestInput): PackageManifestInput {
  if (!jsonObject(input) || !onlyKeys(input, ['artifact_id', 'module'])) throw invalidInput();
  const artifact_id = artifactId(input.artifact_id);
  if (!Object.hasOwn(input, 'module')) return { artifact_id };
  if (typeof input.module !== 'string' || !modulePattern.test(input.module)) throw invalidInput();
  return { artifact_id, module: input.module };
}
export function isApkEntry(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const length = new TextEncoder().encode(value).length;
  return length >= 5 && length <= 500 && /\.[aA][pP][kK]$/.test(value)
    && !/[\\:\u0000-\u001f\u007f-\u009f]/u.test(value)
    && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}
export function normalizeExtract(input: PackageExtractInput): PackageExtractInput {
  if (!jsonObject(input) || !onlyKeys(input, ['artifact_id', 'entry']) || !isApkEntry(input.entry)) throw invalidInput();
  return { artifact_id: artifactId(input.artifact_id), entry: input.entry };
}
