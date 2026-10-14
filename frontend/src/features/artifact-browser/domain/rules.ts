import { ApiError, isArchiveEntries, isArtifactMetadata } from '../../../shared/api/index.ts';
import type { ArchiveEntryQuery } from '../../../shared/api/index.ts';
import { jsonObject, naturalNumber, onlyKeys } from '../../../shared/jobs/index.ts';
import type { ArtifactEntriesView, ArtifactMetadataView } from './types.ts';

export type NormalizedEntryQuery = { readonly offset: number; readonly limit: number };
export function normalizeArtifactFilename(filename: string): string {
  if (typeof filename !== 'string' || filename.length === 0 || new TextEncoder().encode(filename).length > 180
    || filename.startsWith('.') || filename.endsWith('.') || filename.endsWith(' ')
    || [...filename].some((character) => character === '/' || character === '\\' || character === ':' || /\p{Cc}/u.test(character))) {
    throw new ApiError('protocol', 'invalid_artifact_filename', '产物名称必须为不含路径的文件名，最多 180 字节');
  }
  return filename;
}
export function requireArtifactBlob(value: unknown, logId: string | null): Blob {
  if (!(value instanceof Blob)) throw new ApiError('protocol', 'invalid_artifact_content', '产物响应不是原始字节 Blob', null, logId);
  return value;
}
export function normalizeArtifactId(id: string): string {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new ApiError('protocol', 'invalid_artifact_id', '产物身份须为规范 UUID');
  return id.toLowerCase();
}
export function normalizeEntryQuery(query: ArchiveEntryQuery): NormalizedEntryQuery {
  if (!jsonObject(query) || !onlyKeys(query, ['offset', 'limit'])) throw new ApiError('protocol', 'invalid_artifact_query', '目录参数与公开分页契约不兼容');
  const offset = Object.hasOwn(query, 'offset') ? query.offset : 0;
  const limit = Object.hasOwn(query, 'limit') ? query.limit : 50;
  if (!naturalNumber(offset) || !naturalNumber(limit) || limit < 1 || limit > 200) throw new ApiError('protocol', 'invalid_artifact_query', '目录偏移须为非负安全整数，页长须为 1–200');
  return { offset, limit };
}
export function decodeMetadata(value: unknown, id: string, logId: string | null): ArtifactMetadataView {
  if (!isArtifactMetadata(value) || value.id !== id) throw new ApiError('protocol', 'invalid_artifact_metadata', '产物元数据与请求身份或公开契约不兼容', null, logId);
  return Object.freeze({ id: value.id, filename: value.filename, media_type: value.media_type, size: value.size, sha256: value.sha256, created_at: value.created_at });
}
export function decodeUpload(value: unknown, filename: string, size: number, logId: string | null): ArtifactMetadataView {
  if (!isArtifactMetadata(value) || value.filename !== filename || value.size !== size) {
    throw new ApiError('protocol', 'invalid_artifact_upload', '上传响应元数据与原始文件不一致', null, logId);
  }
  return Object.freeze({ id: value.id, filename: value.filename, media_type: value.media_type, size: value.size, sha256: value.sha256, created_at: value.created_at });
}
export function decodeEntries(value: unknown, query: NormalizedEntryQuery, logId: string | null): ArtifactEntriesView {
  if (!isArchiveEntries(value) || query.offset > value.total || value.entries.length !== Math.min(query.limit, value.total - query.offset)) {
    throw new ApiError('protocol', 'invalid_artifact_page', '目录页长度与总数或请求偏移不兼容', null, logId);
  }
  const next = query.offset + value.entries.length;
  if (value.next_offset !== (next < value.total ? next : null)) throw new ApiError('protocol', 'invalid_artifact_page', '目录下一偏移与实际页范围不兼容', null, logId);
  return Object.freeze({ total: value.total, next_offset: value.next_offset, entries: Object.freeze(value.entries.map((entry) => Object.freeze({ name: entry.name, size: entry.size, compressed_size: entry.compressed_size, directory: entry.directory }))) });
}
