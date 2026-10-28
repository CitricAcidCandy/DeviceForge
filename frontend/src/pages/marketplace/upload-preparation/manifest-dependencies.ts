// 读取所选字节中的依赖原包；声明校验仍使用共享规则，不联网或执行工具。
import { validateDependencies, compatibleDependencyVersion, dependencyUrl, type Manifest, type Dependencies, type DependencySource } from '@deviceforge/plugin-manifest';
import { sha256 } from '@noble/hashes/sha2.js';
import { readTgz, readZip } from './archives.ts';
import type { ArchiveFile } from './types.ts';

const digest = (bytes: Uint8Array) => [...sha256(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
async function verifyDependency(file: ArchiveFile, source: DependencySource) {
  if (file.bytes.byteLength !== source.size || digest(file.bytes) !== source.sha256)
    throw new Error('依赖输入摘要或大小不符');
  const members = source.format === 'file' ? [{ path: 'payload', bytes: file.bytes }] :
    source.format === 'tgz' ? await readTgz(file.bytes, false) : readZip(file.bytes, false);
  const prefix = members.every(member => member.path.startsWith('package/')) ? 'package/' : '';
  for (const path of Object.values(source.entries)) {
    if (!members.some(member => member.path === prefix + path)) throw new Error(`依赖缺少声明入口：${path}`);
  }
}

export async function prepareManifestDependencies(declaration: Manifest, files: readonly ArchiveFile[], blobs: Map<string, Uint8Array>): Promise<Dependencies> {
  const dependencies = structuredClone(declaration.release.dependencies ?? { format_version: 1, dependencies: [] });
  for (const item of dependencies.dependencies) {
    const supplied = declaration.dependency_files[item.id];
    for (const input of supplied === undefined ? [] : Array.isArray(supplied) ? supplied : [supplied]) {
      const file = files.find(file => file.path === input.file);
      if (!file || !compatibleDependencyVersion(item.version_requirement, input.version)) throw new Error(`依赖缺真实文件或版本不满足范围：${item.id}`);
      const measured = { sha256: digest(file.bytes), size: file.bytes.byteLength };
      if ((input.sha256 !== undefined && input.sha256 !== measured.sha256) || (input.size !== undefined && input.size !== measured.size))
        throw new Error(`依赖输入摘要或大小不符：${item.id}`);
      const source: DependencySource = { kind: 'market', url: `blobs/${measured.sha256}`, platform: input.platform,
        version: input.version, format: input.format, entries: input.entries, ...measured };
      validateDependencies({ format_version: 1, dependencies: [{ ...item, requires: [], sources: [source] }] });
      await verifyDependency(file, source);
      blobs.set(source.url, file.bytes);
      item.sources ??= [];
      if (!item.sources.some(other => JSON.stringify(other) === JSON.stringify(source))) item.sources.push(source);
    }
    for (const source of item.sources ?? []) {
      if (source.kind !== 'market') continue;
      const bytes = blobs.get(`blobs/${source.sha256}`);
      const file = bytes ? { path: source.url, bytes } : !dependencyUrl(source) ? files.find(file => file.path === source.url) : undefined;
      if (!file) throw new Error(`市场依赖须提供可核验的本地输入：${item.id}`);
      await verifyDependency(file, source);
      source.url = `blobs/${source.sha256}`;
      blobs.set(source.url, file.bytes);
    }
  }
  return validateDependencies(dependencies);
}

