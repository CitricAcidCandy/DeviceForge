import type {
  ArtifactEntriesView, ArtifactMetadataView, EntryQuery, FileFailureConstructor,
} from './types.ts';

export type NormalizedEntryQuery = { readonly offset: number; readonly limit: number };
export const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const natural = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isArtifactMetadata(value: unknown): value is ArtifactMetadataView {
  return record(value) && text(value.id) && uuid.test(value.id) && text(value.filename) &&
    text(value.mediaType) && natural(value.size) && natural(value.createdAt) &&
    typeof value.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(value.sha256);
}
function isArchiveEntries(value: unknown): value is ArtifactEntriesView {
  return record(value) && natural(value.total) &&
    (value.nextOffset === null || natural(value.nextOffset)) && Array.isArray(value.entries) &&
    value.entries.every((entry: unknown) => record(entry) && text(entry.name) &&
      natural(entry.size) && natural(entry.compressedSize) && typeof entry.directory === 'boolean');
}

export function createFileRules(ApiError: FileFailureConstructor) {
  function normalizeArtifactFilename(filename: string): string {
    if (
      typeof filename !== 'string' ||
      filename.length === 0 ||
      new TextEncoder().encode(filename).length > 180 ||
      filename.startsWith('.') ||
      filename.endsWith('.') ||
      filename.endsWith(' ') ||
      [...filename].some(
        (character) =>
          character === '/' || character === '\\' || character === ':' || /\p{Cc}/u.test(character),
      )
    ) {
      throw new ApiError(
        'protocol',
        'invalid_artifact_filename',
        '产物名称必须为不含路径的文件名，最多 180 字节',
      );
    }
    return filename;
  }
  function requireArtifactBlob(value: unknown, logId: string | null): Blob {
    if (!(value instanceof Blob))
      throw new ApiError(
        'protocol',
        'invalid_artifact_content',
        '产物响应不是原始字节 Blob',
        null,
        logId,
      );
    return value;
  }
  function normalizeArtifactId(id: string): string {
    if (
      typeof id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    )
      throw new ApiError('protocol', 'invalid_artifact_id', '产物身份须为规范 UUID');
    return id.toLowerCase();
  }
  function normalizeEntryQuery(query: EntryQuery): NormalizedEntryQuery {
    if (!record(query) || !Object.keys(query).every((key) => ['offset', 'limit'].includes(key)))
      throw new ApiError('protocol', 'invalid_artifact_query', '目录参数与公开分页契约不兼容');
    const offset = Object.hasOwn(query, 'offset') ? query.offset : 0;
    const limit = Object.hasOwn(query, 'limit') ? query.limit : 50;
    if (!natural(offset) || !natural(limit) || limit < 1 || limit > 200)
      throw new ApiError(
        'protocol',
        'invalid_artifact_query',
        '目录偏移须为非负安全整数，页长须为 1–200',
      );
    return { offset, limit };
  }
  function decodeMetadata(
    value: unknown,
    id: string,
    logId: string | null,
  ): ArtifactMetadataView {
    if (!isArtifactMetadata(value) || value.id !== id)
      throw new ApiError(
        'protocol',
        'invalid_artifact_metadata',
        '产物元数据与请求身份或公开契约不兼容',
        null,
        logId,
      );
    return Object.freeze({
      id: value.id,
      filename: value.filename,
      mediaType: value.mediaType,
      size: value.size,
      sha256: value.sha256,
      createdAt: value.createdAt,
    });
  }
  function decodeUpload(
    value: unknown,
    filename: string,
    size: number,
    logId: string | null,
  ): ArtifactMetadataView {
    if (!isArtifactMetadata(value) || value.filename !== filename || value.size !== size) {
      throw new ApiError(
        'protocol',
        'invalid_artifact_upload',
        '上传响应元数据与原始文件不一致',
        null,
        logId,
      );
    }
    return Object.freeze({
      id: value.id,
      filename: value.filename,
      mediaType: value.mediaType,
      size: value.size,
      sha256: value.sha256,
      createdAt: value.createdAt,
    });
  }
  function decodeEntries(
    value: unknown,
    query: NormalizedEntryQuery,
    logId: string | null,
  ): ArtifactEntriesView {
    if (
      !isArchiveEntries(value) ||
      query.offset > value.total ||
      value.entries.length !== Math.min(query.limit, value.total - query.offset)
    ) {
      throw new ApiError(
        'protocol',
        'invalid_artifact_page',
        '目录页长度与总数或请求偏移不兼容',
        null,
        logId,
      );
    }
    const next = query.offset + value.entries.length;
    if (value.nextOffset !== (next < value.total ? next : null))
      throw new ApiError(
        'protocol',
        'invalid_artifact_page',
        '目录下一偏移与实际页范围不兼容',
        null,
        logId,
      );
    return Object.freeze({
      total: value.total,
      nextOffset: value.nextOffset,
      entries: Object.freeze(
        value.entries.map((entry) =>
          Object.freeze({
            name: entry.name,
            size: entry.size,
            compressedSize: entry.compressedSize,
            directory: entry.directory,
          }),
        ),
      ),
    });
  }
  return {
    normalizeArtifactFilename, requireArtifactBlob, normalizeArtifactId, normalizeEntryQuery,
    decodeMetadata, decodeUpload, decodeEntries,
  };
}
