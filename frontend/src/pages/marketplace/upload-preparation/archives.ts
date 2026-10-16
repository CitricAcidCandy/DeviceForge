import { Gunzip, Unzip, UnzipInflate, gzipSync, zipSync, type Zippable } from 'fflate';
import { extract, pack } from 'it-tar';
import { MAX_FILE_COUNT, MAX_FOLDER_BYTES, MAX_PLUGIN_BYTES, safeRelativePath, validateFiles } from './rules.ts';
import type { ArchiveFile } from './types.ts';
import { crc32, zipDirectory } from './zip-directory.ts';

function concat(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

export function readZip(data: Uint8Array, plugin: boolean): ArchiveFile[] {
  const records = zipDirectory(data, plugin);
  const files: ArchiveFile[] = [];
  let total = 0;
  let count = 0;
  const unzip = new Unzip(file => {
    if (++count > MAX_FILE_COUNT) throw new Error('归档超过 4096 项');
    const directory = file.name.endsWith('/');
    const path = safeRelativePath(directory ? file.name.slice(0, -1) : file.name);
    if ((file.originalSize ?? 0) > (plugin ? MAX_PLUGIN_BYTES : MAX_FOLDER_BYTES)) throw new Error('归档成员超过大小限制');
    const chunks: Uint8Array[] = [];
    let size = 0;
    file.ondata = (error, chunk, final) => {
      if (error) throw error;
      size += chunk.byteLength;
      total += chunk.byteLength;
      if (total > MAX_FOLDER_BYTES || (plugin && size > MAX_PLUGIN_BYTES)) throw new Error('归档展开超过大小限制');
      if (directory && size) throw new Error('归档目录包含非法内容');
      chunks.push(chunk);
      if (final && !directory) {
        const bytes = concat(chunks, size);
        const record = records.get(path);
        if (!record || record.size !== size || record.crc !== crc32(bytes)) throw new Error('ZIP 成员内容与目录校验不一致');
        files.push({ path, bytes, mode: record.mode });
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for (let offset = 0; offset < data.byteLength; offset += 65536)
    unzip.push(data.subarray(offset, offset + 65536), offset + 65536 >= data.byteLength);
  validateFiles(files, plugin);
  if (files.length !== records.size) throw new Error('ZIP 目录与实际成员不一致');
  return files;
}

function gunzipBounded(data: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const stream = new Gunzip(chunk => {
    size += chunk.byteLength;
    // TAR 头和对齐也计入上限，避免压缩包在解析前占用无界内存。
    if (size > MAX_FOLDER_BYTES + MAX_FILE_COUNT * 2048) throw new Error('TGZ 展开超过大小限制');
    chunks.push(chunk);
  });
  for (let offset = 0; offset < data.byteLength; offset += 65536)
    stream.push(data.subarray(offset, offset + 65536), offset + 65536 >= data.byteLength);
  return concat(chunks, size);
}

export async function readTgz(data: Uint8Array, plugin: boolean): Promise<ArchiveFile[]> {
  const files: ArchiveFile[] = [];
  let count = 0;
  let total = 0;
  for await (const entry of extract()([gunzipBounded(data)])) {
    if (++count > MAX_FILE_COUNT) throw new Error('归档超过 4096 项');
    const directory = entry.header.type === 'directory';
    if (!directory && entry.header.type !== 'file') throw new Error('归档不支持链接、设备或特殊文件');
    const path = safeRelativePath(entry.header.name.replace(/\/$/, ''));
    if (entry.header.size > (plugin ? MAX_PLUGIN_BYTES : MAX_FOLDER_BYTES)) throw new Error('归档成员超过大小限制');
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of entry.body) {
      size += chunk.byteLength;
      total += chunk.byteLength;
      if (total > MAX_FOLDER_BYTES || (plugin && size > MAX_PLUGIN_BYTES)) throw new Error('归档展开超过大小限制');
      chunks.push(chunk);
    }
    if (size !== entry.header.size) throw new Error('TAR 成员长度不一致');
    if (!directory) files.push({ path, bytes: concat(chunks, size), mode: entry.header.mode });
  }
  validateFiles(files, plugin);
  return files;
}

export async function writeArchive(files: readonly ArchiveFile[], tgz: boolean): Promise<Uint8Array> {
  if (!tgz) {
    const entries: Zippable = Object.create(null) as Zippable;
    for (const file of files) entries[file.path] = [file.bytes, { level: 6, os: 3, attrs: (file.mode ?? 0o100644) << 16 }];
    return zipSync(entries);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of pack()(files.map(file => ({ header: { name: file.path, mode: file.mode ?? 0o644, size: file.bytes.byteLength, type: 'file' }, body: file.bytes })))) {
    size += chunk.byteLength;
    chunks.push(chunk);
  }
  return gzipSync(concat(chunks, size), { level: 6, mtime: 0 });
}
