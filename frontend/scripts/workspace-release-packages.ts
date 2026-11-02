import { copyFile, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { packageWorkspaceLibrary } from './package-workspace-library.ts';
import {
  hash, inside, object, readObject, unpackPublicPackage,
} from './workspace-release-inputs.ts';
import type { PublicReleasePackage, ReleaseProject } from './workspace-release-inputs.ts';

export interface PreparedReleasePackages {
  readonly packages: readonly PublicReleasePackage[];
  readonly imports: Readonly<Record<string, string>>;
}
function localDependencies(metadata: Readonly<Record<string, unknown>>): readonly [string, string][] {
  const result: [string, string][] = [];
  for (const kind of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const entries = metadata[kind];
    if (entries === undefined) continue;
    if (!object(entries)) throw new Error('插件依赖必须是对象');
    for (const [name, version] of Object.entries(entries)) {
      if (typeof version !== 'string') throw new Error('插件依赖版本无效');
      if (version.startsWith('workspace:')) throw new Error('发行需要可定位的公开配套包，不能保留 workspace 占位');
      if (version.startsWith('file:')) result.push([name, version.slice(5)]);
    }
  }
  return result;
}
const directoryName = (name: string): string => name.replace(/^@/, '').replaceAll('/', '-');

async function matchesPublishedDirectory(source: string, issued: string): Promise<boolean> {
  async function compare(directory: string, prefix: string): Promise<boolean> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name), name = prefix + entry.name;
      if (entry.isDirectory()) { if (!await compare(path, `${name}/`)) return false; }
      else if (!entry.isFile() || hash(await readFile(path)) !== hash(await readFile(join(source, name)))) return false;
    }
    return true;
  }
  try { return await compare(issued, ''); }
  catch (error) { if (object(error) && error.code === 'ENOENT') return false; throw error; }
}

interface PackageSource {
  readonly kind: 'archive' | 'project';
  readonly path: string;
  readonly sha256: string;
}
export function createReleasePackageSources() {
  const sources = new Map<string, PackageSource>();
  return {
    register(name: string, source: PackageSource): void {
      const previous = sources.get(name);
      if (previous && !((previous.kind === 'archive' && source.kind === 'archive' && previous.sha256 === source.sha256) ||
          (previous.kind === 'project' && source.kind === 'project' && previous.path === source.path && previous.sha256 === source.sha256)))
        throw new Error(`同名公开依赖声明了不同来源或字节，不能静默替换：${name}`);
      sources.set(name, source);
    },
  };
}

/** 先发行真实公共依赖，再构建业务安装包；不把开发条件或私有源码交给 bundler。 */
export async function prepareReleasePackages(
  frontend: string, output: string, projects: readonly ReleaseProject[], signal: AbortSignal,
): Promise<PreparedReleasePackages> {
  const packages = new Map<string, PublicReleasePackage>();
  const sources = createReleasePackageSources();
  const building = new Set<string>();
  const archiveRoot = join(output, 'development-packages');
  const extractRoot = join(output, 'public-packages');
  await mkdir(archiveRoot, { recursive: true });
  await mkdir(extractRoot, { recursive: true });
  async function addArchive(file: string, expectedName?: string): Promise<PublicReleasePackage> {
    signal.throwIfAborted();
    const metadataRoot = join(extractRoot, `package-${packages.size + 1}`);
    const unpacked = await unpackPublicPackage(file, metadataRoot);
    if (expectedName && expectedName !== unpacked.name) throw new Error('本地依赖包身份与显式依赖不一致');
    if (packages.has(unpacked.name)) throw new Error('同名公开依赖不能由不同来源覆盖');
    const archive = join(archiveRoot, `${directoryName(unpacked.name)}-${unpacked.version}.tgz`);
    if (!inside(archiveRoot, archive)) throw new Error('公开依赖归档输出越界');
    await copyFile(file, archive, 1);
    const result = { ...unpacked, archive };
    packages.set(result.name, result);
    return result;
  }
  // 只有平台 SDK、生成契约和纯清单规则属于启动工具依赖；业务依赖从工程声明递归取得。
  for (const [name, path] of [
    ['@deviceforge/plugin-sdk', 'sdk/dist/deviceforge-plugin-sdk-0.1.0.tgz'],
    ['@deviceforge/contracts', 'contracts/dist/deviceforge-contracts-0.1.0.tgz'],
    ['@deviceforge/plugin-manifest', 'sdk/dist/deviceforge-plugin-manifest-0.1.0.tgz'],
  ]) {
    if (!name || !path) throw new Error('平台公开包声明无效');
    const archive = join(frontend, path);
    sources.register(name, { kind: 'archive', path: await realpath(archive), sha256: hash(await readFile(archive)) });
    await addArchive(archive, name);
  }
  async function ensureDependencies(root: string, metadata: Readonly<Record<string, unknown>>): Promise<void> {
    for (const [name, source] of localDependencies(metadata)) {
      signal.throwIfAborted();
      if (building.has(name)) throw new Error('公开开发包存在循环依赖，无法形成独立发行顺序');
      const target = resolve(root, source);
      if (!inside(frontend, target)) throw new Error('本地公开依赖不属于当前前端发行范围');
      const path = await realpath(target);
      if (!inside(frontend, path)) throw new Error('本地公开依赖链接越出当前前端发行范围');
      if (target.endsWith('.tgz')) {
        sources.register(name, { kind: 'archive', path, sha256: hash(await readFile(path)) });
        if (!packages.has(name)) await addArchive(target, name);
        continue;
      }
      const existing = packages.get(name);
      if (existing && await matchesPublishedDirectory(path, existing.root)) {
        sources.register(name, { kind: 'archive', path, sha256: existing.sha256 });
        continue;
      }
      if (!inside(join(frontend, 'plugins'), path))
        throw new Error('业务开发库必须是独立插件工程，不得从宿主私有目录发行');
      const dependency = await readObject(join(target, 'package.json'));
      if (dependency.name !== name) throw new Error('本地独立库身份与依赖不一致');
      sources.register(name, { kind: 'project', path, sha256: hash(await readFile(join(path, 'package.json'))) });
      if (packages.has(name)) continue;
      building.add(name);
      await ensureDependencies(target, dependency);
      const built = await packageWorkspaceLibrary({ root: target,
        outputRoot: join(output, 'library-builds', directoryName(name)),
        dependencies: Object.fromEntries([...packages].map(([key, value]) => [key, {
          version: value.version, declarations: value.declarations,
        }])),
      });
      signal.throwIfAborted();
      await addArchive(built.archive, name);
      building.delete(name);
    }
  }
  for (const project of projects) await ensureDependencies(project.root, project.metadata);
  const imports: Record<string, string> = {};
  for (const entry of packages.values()) {
    for (const [name, path] of Object.entries(entry.imports)) {
      if (name in imports) throw new Error('公开开发依赖的模块出口重复');
      imports[name] = path;
    }
  }
  return { packages: [...packages.values()], imports };
}
