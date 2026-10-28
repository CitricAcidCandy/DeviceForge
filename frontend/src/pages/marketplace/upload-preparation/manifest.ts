import {
  normalizeManifest, componentMetadata, marketMetadata, validateRelease,
  releaseResources,

} from '@deviceforge/plugin-manifest';
import { sha256 } from '@noble/hashes/sha2.js';
import { writeArchive } from './archives.ts';
import { prepareManifestDependencies } from './manifest-dependencies.ts';
import { jsonObject, validateFiles } from './rules.ts';
import type { ArchiveFile } from './types.ts';

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value, null, 2) + '\n');
const digest = (bytes: Uint8Array) => [...sha256(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
const reserved = new Set(['package.json', 'plugin.json', 'manifest.json', 'market.json', 'dependencies.json', '.deviceforge-entry.js']);

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
  const value = jsonObject(source.bytes, 'manifest.json');
  // 老便携包允许把运行清单命名为 manifest.json，不能误认成新开发格式。
  if (!Object.hasOwn(value, 'manifest_version') && files.some(file => file.path === 'package.json')) return null;
  const declaration = normalizeManifest(value);
  const blobs = new Map<string, Uint8Array>();
  const dependencies = await prepareManifestDependencies(declaration, files, blobs);
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
