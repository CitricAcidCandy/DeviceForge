import { invalidBusinessResult, nonemptyText } from '../../../shared/jobs/index.ts';
import type { ToolCatalog } from '../types/index.ts';

export const manifestSourceKeys: readonly string[] = [
  'manifest_source',
  'manifest_sha256',
  'source_error',
  'manifest_version',
];
type ManifestSourceResult = Required<
  Pick<ToolCatalog, 'manifest_source' | 'manifest_sha256' | 'source_error'>
>;

export function hasManifestSource(value: Record<string, unknown>): boolean {
  return Object.hasOwn(value, 'manifest_source') || Object.hasOwn(value, 'manifest_sha256');
}

export function decodeManifestSource(
  value: Record<string, unknown>,
  logId: string | null,
  module: string,
  allowUnavailable = false,
): ManifestSourceResult | null {
  if (!hasManifestSource(value)) return null;
  if (!manifestSourceKeys.every((key) => Object.hasOwn(value, key)))
    throw invalidBusinessResult(module, logId);
  if (value.manifest_source === null) {
    if (
      !allowUnavailable ||
      value.manifest_version !== null ||
      value.manifest_sha256 !== null ||
      !nonemptyText(value.source_error)
    ) {
      throw invalidBusinessResult(module, logId);
    }
    return { manifest_source: null, manifest_sha256: null, source_error: value.source_error };
  }
  if (
    !nonemptyText(value.manifest_version) ||
    typeof value.manifest_sha256 !== 'string' ||
    value.manifest_sha256.length !== 64 ||
    !/^[0-9a-f]{64}$/i.test(value.manifest_sha256)
  ) {
    throw invalidBusinessResult(module, logId);
  }
  if (value.manifest_source === 'live' && value.source_error === null) {
    return { manifest_source: 'live', manifest_sha256: value.manifest_sha256, source_error: null };
  }
  if (value.manifest_source === 'cache' && nonemptyText(value.source_error)) {
    return {
      manifest_source: 'cache',
      manifest_sha256: value.manifest_sha256,
      source_error: value.source_error,
    };
  }
  throw invalidBusinessResult(module, logId);
}
