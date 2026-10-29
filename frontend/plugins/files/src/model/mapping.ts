import type { Artifact } from '@deviceforge/plugin-sdk';
import type { ArchivePage } from './types.ts';
import { record } from './rules.ts';

/** 只做边界字段映射，元数据身份、大小及页范围仍由模型校验。 */
export function metadataFromWire(value: unknown): unknown {
  if (!record(value)) return value;
  return {
    id: value.id, filename: value.filename, mediaType: value.media_type,
    size: value.size, sha256: value.sha256, createdAt: value.created_at,
  };
}
export function entriesFromWire(value: unknown): unknown {
  if (!record(value)) return value;
  return {
    total: value.total, nextOffset: value.next_offset,
    entries: Array.isArray(value.entries) ? value.entries.map((entry: unknown) =>
      record(entry) ? {
        name: entry.name, size: entry.size, compressedSize: entry.compressed_size,
        directory: entry.directory,
      } : entry) : value.entries,
  };
}
export function metadataToWire(value: Artifact) {
  return Object.freeze({
    id: value.id, filename: value.filename, media_type: value.mediaType,
    size: value.size, sha256: value.sha256, created_at: value.createdAt,
  });
}
export function entriesToWire(value: ArchivePage) {
  return Object.freeze({
    total: value.total, next_offset: value.nextOffset,
    entries: Object.freeze(value.entries.map((entry) => Object.freeze({
      name: entry.name, size: entry.size, compressed_size: entry.compressedSize,
      directory: entry.directory,
    }))),
  });
}
