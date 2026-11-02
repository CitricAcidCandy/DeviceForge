import { MAX_FILE_COUNT, MAX_FOLDER_BYTES, safeRelativePath } from './rules.ts';
import type { UploadInputFile, UploadSelection } from './types.ts';
import { abortable } from '@deviceforge/business-kit/api';

function fileEntry(value: FileSystemEntry): value is FileSystemFileEntry {
  return value.isFile && 'file' in value && typeof value.file === 'function';
}
function directoryEntry(value: FileSystemEntry): value is FileSystemDirectoryEntry {
  return value.isDirectory && 'createReader' in value && typeof value.createReader === 'function';
}

export function directorySelection(files: readonly File[]): UploadSelection {
  const firstPath = files[0]?.webkitRelativePath;
  if (!firstPath) throw new Error('浏览器未返回目录路径，请使用 ZIP/TGZ 上传');
  const root = firstPath.split('/')[0] ?? 'resource';
  const items = files.map(file => {
    if (!file.webkitRelativePath.startsWith(root + '/')) throw new Error('请选择一个完整文件夹');
    return { path: safeRelativePath(file.webkitRelativePath.slice(root.length + 1)), file };
  });
  return { mode: 'directory', name: root, files: items };
}

export async function droppedSelection(items: DataTransferItemList, signal: AbortSignal): Promise<UploadSelection | null> {
  const entries = Array.from(items).filter(item => item.kind === 'file').map(item => item.webkitGetAsEntry());
  if (!entries.some(entry => entry?.isDirectory)) return null;
  if (entries.length !== 1 || !entries[0] || !directoryEntry(entries[0])) throw new Error('请一次拖入一个文件夹');
  const root = entries[0];
  const files: UploadInputFile[] = [];
  let count = 0;
  let size = 0;
  async function visit(entry: FileSystemEntry, parent: string) {
    signal.throwIfAborted();
    if (++count > MAX_FILE_COUNT) throw new Error('文件夹超过 4096 项');
    const path = safeRelativePath(parent + entry.name);
    if (fileEntry(entry)) {
      const file = await abortable(new Promise<File>((resolve, reject) => entry.file(resolve, reject)), signal);
      signal.throwIfAborted();
      size += file.size;
      if (size > MAX_FOLDER_BYTES) throw new Error('文件夹超过 256 MiB');
      files.push({ path, file });
    } else if (directoryEntry(entry)) {
      const reader = entry.createReader();
      while (true) {
        const children = await abortable(new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject)), signal);
        signal.throwIfAborted();
        if (!children.length) break;
        for (const child of children) await visit(child, path + '/');
      }
    }
  }
  const reader = root.createReader();
  while (true) {
    const children = await abortable(new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject)), signal);
    signal.throwIfAborted();
    if (!children.length) break;
    for (const child of children) await visit(child, '');
  }
  return { mode: 'directory', name: root.name, files };
}
