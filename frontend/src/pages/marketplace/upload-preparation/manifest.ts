import {
  normalizeManifest, componentMetadata, marketMetadata, validateRelease,
  validateDependencies, compatibleDependencyVersion, dependencyUrl, releaseResources,
  type Manifest, type Dependencies, type DependencySource,
} from '@deviceforge/plugin-manifest';
import { sha256 } from '@noble/hashes/sha2.js';
import { readTgz, readZip, writeArchive } from './archives.ts';
import { jsonObject, validateFiles } from './rules.ts';
import type { ArchiveFile } from './types.ts';

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value, null, 2) + '\n');
const digest = (bytes: Uint8Array) => [...sha256(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
const reserved = new Set(['package.json', 'plugin.json', 'manifest.json', 'market.json', 'dependencies.json', '.deviceforge-entry.js']);

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

async function prepareDependencies(declaration: Manifest, files: readonly ArchiveFile[], blobs: Map<string, Uint8Array>): Promise<Dependencies> {
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

export async function generateManifestFiles(input: readonly ArchiveFile[], complete: boolean) {
  // 支持直接工程目录，以及 ZIP/TGZ 外包一层工程目录；不猜测嵌套组件里的清单。
  const candidates = input.filter(file => file.path === 'manifest.json' ||
    /^[^/]+\/manifest\.json$/.test(file.path) && input.every(other => other.path.startsWith(file.path.slice(0, file.path.lastIndexOf('/') + 1))));
  if (!candidates.length) return null;
  if (candidates.length !== 1) throw new Error('请选择仅有一份根 manifest.json 的插件工程');
  const source = candidates[0];
  if (!source) return null;
  const prefix = source.path.slice(0, -'manifest.json'.length);
  const files = input.map(file => ({ ...file, path: file.path.slice(prefix.length) }));
  const declaration = normalizeManifest(jsonObject(source.bytes, 'manifest.json'));
  const blobs = new Map<string, Uint8Array>();
  const dependencies = await prepareDependencies(declaration, files, blobs);
  if (!complete && (declaration.components.length !== 1 || dependencies.dependencies.length || declaration.release.requirements?.length))
    throw new Error('配套组件、依赖或用户输入请使用“从本地导入”，或打包后使用完整功能插件发布入口');
  const components = [];
  let portable: ArchiveFile[] = [];
  for (const component of declaration.components) {
    const root = component.root === '.' ? '' : component.root + '/';
    const members: ArchiveFile[] = [];
    for (const path of component.files) {
      const selected = files.filter(file => file.path === root + path || file.path.startsWith(root + path + '/'));
      if (!selected.length) throw new Error(`组件 files 未找到构建产物：${path}`);
      for (const file of selected) {
        const relative = file.path.slice(root.length);
        if (reserved.has(relative)) throw new Error(`文件 ${relative} 由开发清单生成，请从 files 中移除`);
        if (!members.some(member => member.path === relative)) members.push({ ...file, path: relative });
      }
    }
    for (const entry of Object.values(component.entrypoints)) {
      if (!members.some(file => file.path === entry.path)) throw new Error(`组件 files 未包含入口：${entry.path}`);
    }
    for (const [path, content] of componentMetadata(declaration, component, dependencies)) members.push({ path, bytes: new TextEncoder().encode(content) });
    validateFiles(members, true);
    portable = members;
    if (!complete) continue;
    const bytes = await writeArchive(members.map(file => ({ ...file, path: 'package/' + file.path })), true);
    const checksum = digest(bytes), path = `blobs/${checksum}`;
    blobs.set(path, bytes);
    const platforms = Object.keys(component.entrypoints);
    components.push({ id: component.id, kind: component.kind, version: component.version,
      variants: platforms.map(platform => ({ platform, path, sha256: checksum, size: bytes.byteLength, format: 'tgz' })) });
  }
  if (!complete) return { files: portable, release: undefined };
  const release = validateRelease({ ...declaration.release, components, dependencies });
  for (const resource of releaseResources(release)) if (!blobs.has(resource.path)) throw new Error(`发布缺少本地资源：${resource.path}`);
  const metadata = marketMetadata(declaration, declaration, { release_format_version: 2, host_api_version: 2 });
  return { files: [{ path: 'release.json', bytes: encode(release) }, { path: 'market.json', bytes: encode(metadata) },
    ...[...blobs].map(([path, bytes]) => ({ path, bytes }))],
    release: { id: release.id, version: release.version, name: release.name, componentCount: release.components.length, toolCount: release.tools?.length ?? 0 } };
}
