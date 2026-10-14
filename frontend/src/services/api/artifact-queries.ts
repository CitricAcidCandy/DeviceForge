import { encodedId } from './endpoints.ts';
import { ApiError } from './errors.ts';
import type { paths } from './generated.ts';
import type { Endpoint } from './types.ts';
import { isRecord } from './validation.ts';

export type ArtifactMetadata =
  paths['/api/v2/artifacts/{id}']['get']['responses'][200]['content']['application/json']['data'];
export type ArchiveEntries =
  paths['/api/v2/artifacts/{id}/entries']['get']['responses'][200]['content']['application/json']['data'];
export type ArchiveEntryQuery = NonNullable<
  paths['/api/v2/artifacts/{id}/entries']['get']['parameters']['query']
>;
type MetadataPath = paths['/api/v2/artifacts/{id}']['parameters']['path'];
type EntriesInput = paths['/api/v2/artifacts/{id}/entries']['parameters']['path'] & {
  readonly query: ArchiveEntryQuery;
};
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const natural = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
function checkedId(id: string): string {
  if (typeof id !== 'string' || !uuidPattern.test(id))
    throw new ApiError('protocol', 'invalid_artifact_id', '产物身份须为规范 UUID');
  return encodedId(id.toLowerCase());
}
export function isArtifactMetadata(value: unknown): value is ArtifactMetadata {
  return (
    isRecord(value) &&
    text(value.id) &&
    uuidPattern.test(value.id) &&
    text(value.filename) &&
    text(value.media_type) &&
    natural(value.size) &&
    natural(value.created_at) &&
    typeof value.sha256 === 'string' &&
    /^[0-9a-f]{64}$/i.test(value.sha256)
  );
}
export function isArchiveEntries(value: unknown): value is ArchiveEntries {
  return (
    isRecord(value) &&
    natural(value.total) &&
    (value.next_offset === null || natural(value.next_offset)) &&
    Array.isArray(value.entries) &&
    value.entries.every(
      (entry: unknown) =>
        isRecord(entry) &&
        text(entry.name) &&
        natural(entry.size) &&
        natural(entry.compressed_size) &&
        typeof entry.directory === 'boolean',
    )
  );
}
export const artifactMetadataEndpoint: Endpoint<MetadataPath, ArtifactMetadata> = {
  request: ({ id }) => ({ path: `/api/v2/artifacts/${checkedId(id)}`, method: 'GET' }),
  decode: isArtifactMetadata,
};
export const artifactDeleteEndpoint: Endpoint<MetadataPath, ArtifactMetadata> = {
  request: ({ id }) => ({ path: `/api/v2/artifacts/${checkedId(id)}`, method: 'DELETE' }),
  decode: isArtifactMetadata,
};
export const artifactEntriesEndpoint: Endpoint<EntriesInput, ArchiveEntries> = {
  request: ({ id, query }) => {
    const params = new URLSearchParams();
    if (query.offset !== undefined) {
      if (!natural(query.offset))
        throw new ApiError('protocol', 'invalid_artifact_query', '目录偏移须为非负安全整数');
      params.set('offset', String(query.offset));
    }
    if (query.limit !== undefined) {
      if (!natural(query.limit) || query.limit < 1 || query.limit > 200)
        throw new ApiError('protocol', 'invalid_artifact_query', '目录页长须为 1–200 的整数');
      params.set('limit', String(query.limit));
    }
    return {
      path: `/api/v2/artifacts/${checkedId(id)}/entries${params.size ? '?' + params : ''}`,
      method: 'GET',
    };
  },
  decode: isArchiveEntries,
};
