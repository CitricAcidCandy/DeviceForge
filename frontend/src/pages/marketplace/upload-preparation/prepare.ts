import { sha256 } from '@noble/hashes/sha2.js';
import { readTgz, readZip, writeArchive } from './archives.ts';
import { checkIdentity, importedMetadata, pluginIdentity } from './metadata.ts';
import { generateManifestFiles } from './manifest.ts';
import { excludedPath, MAX_FILE_COUNT, MAX_FOLDER_BYTES, MAX_PLUGIN_BYTES, MAX_RESOURCE_BYTES, safeRelativePath, validateFiles } from './rules.ts';
import type { ArchiveFile, PreparationRequest, PreparedUpload, UploadInspection } from './types.ts';

async function digest(file: File): Promise<string> {
  const hash = sha256.create();
  const reader = file.stream().getReader();
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      hash.update(part.value);
    }
  } finally { reader.releaseLock(); }
  return Array.from(hash.digest(), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function prepareUpload(request: PreparationRequest): Promise<UploadInspection | PreparedUpload> {
  const { selection, kind, metadata } = request;
  const plugin = kind === 'plugin';
  const single = selection.files[0];
  if (!single || !selection.files.length) throw new Error('请选择上传内容');
  const archive = selection.mode === 'archive' || (plugin && /\.(zip|tgz|tar\.gz)$/i.test(single.file.name));
  const directory = selection.mode === 'directory';
  if (!archive && !directory) {
    if (plugin) throw new Error('插件请选择已构建文件夹或 ZIP/TGZ 便携包');
    if (single.file.size > MAX_RESOURCE_BYTES) throw new Error('单文件超过资源服务 2 GiB 上限');
    const inspection: UploadInspection = { files: [{ path: single.file.name, size: single.file.size }], excluded: [], totalSize: single.file.size, metadata: null, identity: null };
    return metadata ? { file: single.file, sha256: await digest(single.file), inspection } : inspection;
  }
  if (selection.files.length > MAX_FILE_COUNT) throw new Error('文件数量超过 4096 项');
  if (archive && single.file.size > (plugin ? MAX_PLUGIN_BYTES : MAX_FOLDER_BYTES)) throw new Error('归档超过上传限制');
  const excluded: string[] = [];
  let files: ArchiveFile[];
  let tgz = archive && /\.(tgz|tar\.gz)$/i.test(single.file.name);
  if (archive) {
    const bytes = new Uint8Array(await single.file.arrayBuffer());
    files = tgz ? await readTgz(bytes, plugin) : readZip(bytes, plugin);
  } else {
    let size = 0;
    files = [];
    for (const input of selection.files) {
      const path = safeRelativePath(input.path);
      if (excludedPath(path)) { excluded.push(path); continue; }
      size += input.file.size;
      if (size > MAX_FOLDER_BYTES || (plugin && input.file.size > MAX_PLUGIN_BYTES)) throw new Error('文件夹超过 256 MiB 或插件单文件超过 64 MiB');
      files.push({ path, bytes: new Uint8Array(await input.file.arrayBuffer()) });
    }
  }
  files = files.filter(file => {
    if (excludedPath(file.path)) { excluded.push(file.path); return false; }
    return true;
  });
  validateFiles(files, plugin);
  const generated = plugin ? await generateManifestFiles(files, request.localImport === true) : null;
  if (generated) { files = generated.files; tgz = false; validateFiles(files, plugin); }
  const prefix = tgz && files.every(file => file.path.startsWith('package/')) ? 'package/' : '';
  const identity = plugin && !generated?.release ? pluginIdentity(files, prefix) : null;
  const imported = importedMetadata(files.find(file => file.path === prefix + 'market.json'));
  if (imported && imported.kind !== kind) throw new Error('包内市场类型与所选类型不一致');
  if (imported) checkIdentity(identity, imported);
  const inspection: UploadInspection = {
    files: files.map(file => ({ path: file.path, size: file.bytes.byteLength })), excluded,
    totalSize: files.reduce((sum, file) => sum + file.bytes.byteLength, 0), metadata: imported, identity,
    ...(generated?.release ? { release: generated.release } : {}),
  };
  if (!metadata && !generated && (!request.localImport || archive)) return inspection;
  const finalMetadata = metadata ?? imported;
  if (finalMetadata) {
  checkIdentity(identity, finalMetadata);
  if (generated?.release && (finalMetadata.id !== generated.release.id || finalMetadata.version !== generated.release.version))
    throw new Error('市场身份与开发清单不一致');
  // 资源摘要属于最终归档，不能把自身摘要写回归档形成循环依赖。
  const { resource_id: _resourceId, ...embedded } = finalMetadata;
  const marketBytes = new TextEncoder().encode(JSON.stringify(embedded, null, 2));
  files = [...files.filter(file => file.path !== prefix + 'market.json'), { path: prefix + 'market.json', bytes: marketBytes }];
  }
  validateFiles(files, plugin);
  const bytes = await writeArchive(files, tgz);
  if (plugin && bytes.byteLength > MAX_PLUGIN_BYTES) throw new Error('插件归档超过 64 MiB 上传限制');
  const filename = generated ? `${generated.release?.id ?? identity?.id ?? 'plugin'}.zip` : archive ? single.file.name : `${selection.name || 'resource'}.zip`;
  const file = new File([new Uint8Array(bytes).buffer], filename, { type: tgz ? 'application/gzip' : 'application/zip' });
  return { file, sha256: await digest(file), inspection: { ...inspection, files: files.map(item => ({ path: item.path, size: item.bytes.byteLength })), totalSize: files.reduce((sum, item) => sum + item.bytes.byteLength, 0), metadata: finalMetadata } };
}
