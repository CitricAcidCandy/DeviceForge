import type { ArchiveFile } from './types.ts';

export const MAX_FOLDER_BYTES = 256 * 1024 * 1024;
export const MAX_PLUGIN_BYTES = 64 * 1024 * 1024;
export const MAX_FILE_COUNT = 4096;
export const MAX_RESOURCE_BYTES = 2 * 1024 * 1024 * 1024;

export function safeRelativePath(path: string): string {
  const normalized = path.normalize('NFC');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\\') ||
      /[:\x00-\x1f]/.test(normalized) || normalized.split('/').some(part => !part || part === '.' || part === '..'))
    throw new Error(`归档路径无效：${path}`);
  return normalized;
}

export function excludedPath(path: string): boolean {
  return path.split('/').some(part => ['.git', '.svn', '.DS_Store', 'Thumbs.db'].includes(part));
}

export function validateFiles(files: readonly ArchiveFile[], plugin: boolean): void {
  if (!files.length) throw new Error('没有可上传的文件');
  if (files.length > MAX_FILE_COUNT) throw new Error('文件数量超过 4096 项');
  const seen = new Set<string>();
  let size = 0;
  for (const file of files) {
    const path = safeRelativePath(file.path);
    const key = path.toLowerCase();
    if (seen.has(key)) throw new Error(`重复文件路径：${path}`);
    seen.add(key);
    size += file.bytes.byteLength;
    if (plugin && file.bytes.byteLength > MAX_PLUGIN_BYTES) throw new Error('插件单文件超过 64 MiB');
    if (size > MAX_FOLDER_BYTES) throw new Error('文件夹或归档展开后超过 256 MiB');
  }
  for (const path of seen) {
    const parts = path.split('/');
    parts.pop();
    while (parts.length) {
      if (seen.has(parts.join('/'))) throw new Error(`文件与目录路径冲突：${path}`);
      parts.pop();
    }
  }
}

export function jsonObject(bytes: Uint8Array, name: string): Record<string, unknown> {
  if (bytes.byteLength > 1024 * 1024) throw new Error(`${name} 超过 1 MiB`);
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} 必须为 JSON 对象`);
  return value as Record<string, unknown>;
}
