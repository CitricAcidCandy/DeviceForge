import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { extract } from 'it-tar';

export interface ReleaseProject {
  readonly root: string;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly entry: string;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly metadata: Readonly<Record<string, unknown>>;
}
export interface PublicReleasePackage {
  readonly name: string;
  readonly version: string;
  readonly root: string;
  readonly archive: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly imports: Readonly<Record<string, string>>;
  readonly declarations: Readonly<Record<string, string>>;
}
export const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export const hash = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');
export function inside(root: string, path: string): boolean {
  const part = relative(resolve(root), resolve(path));
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}
export async function readObject(path: string): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!object(parsed)) throw new Error('发行输入必须是 JSON 对象');
  return parsed;
}

export async function releaseSourceIdentity(root: string) {
  const files: { name: string; sha256: string }[] = [];
  async function walk(directory: string, prefix: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const path = join(directory, entry.name), name = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error('发行源码不能通过链接读取其他工程');
      if (entry.isDirectory()) await walk(path, `${name}/`);
      else if (entry.isFile()) files.push({ name, sha256: hash(await readFile(path)) });
      else throw new Error('发行源码包含非普通文件');
    }
  }
  await walk(join(root, 'src'), 'src/');
  for (const name of ['package.json', 'manifest.json']) files.push({ name, sha256: hash(await readFile(join(root, name))) });
  return files;
}
async function regularInside(root: string, name: string): Promise<string> {
  if (name.includes('\\') || name.includes('\0') || !inside(root, resolve(root, name)))
    throw new Error('发行入口必须位于自身工程内部');
  const path = resolve(root, name);
  if (!(await lstat(path)).isFile() || !inside(await realpath(root), await realpath(path)))
    throw new Error('发行入口不是本工程的普通文件');
  return path;
}

/** 来源按单清单发现；增加业务插件不需要同步维护发行数组。 */
export async function releaseProjects(pluginsRoot: string): Promise<readonly ReleaseProject[]> {
  const projects: ReleaseProject[] = [];
  const ids = new Set<string>(), names = new Set<string>();
  for (const directory of (await readdir(pluginsRoot, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (!directory.isDirectory()) continue;
    const root = join(pluginsRoot, directory.name);
    let manifest: Record<string, unknown>;
    try { manifest = await readObject(join(root, 'manifest.json')); }
    catch (error) {
      if (object(error) && error.code === 'ENOENT') continue;
      throw error;
    }
    if (manifest.manifest_version !== 1 || typeof manifest.id !== 'string' ||
        !/^[a-z][a-z0-9._-]{0,98}$/.test(manifest.id) || typeof manifest.version !== 'string' ||
        !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(manifest.version) || !Array.isArray(manifest.components))
      throw new Error('随附插件开发清单身份无效');
    const components = manifest.components.filter((entry: unknown) => object(entry) && entry.kind === 'browser');
    if (components.length !== 1 || manifest.components.length !== 1)
      throw new Error('官方浏览器发行入口仅接收独立单浏览器组件工程');
    const component: unknown = components[0];
    if (!object(component) || (component.root !== undefined && component.root !== '.') ||
        !Array.isArray(component.files) || component.files.length !== 1 || component.files[0] !== 'dist' ||
        !object(component.entrypoints) || !object(component.entrypoints.any) ||
        component.entrypoints.any.runtime !== 'browser' || component.entrypoints.any.path !== 'dist/index.js')
      throw new Error('随附浏览器组件必须从隔离 dist/index.js 发行');
    const metadata = await readObject(join(root, 'package.json'));
    if (typeof metadata.name !== 'string' || metadata.type !== 'module') throw new Error('插件开发包身份无效');
    if (ids.has(manifest.id) || names.has(metadata.name)) throw new Error('发行来源存在重复身份');
    ids.add(manifest.id); names.add(metadata.name);
    let source: string | undefined;
    if (object(metadata.exports)) {
      const entry: unknown = metadata.exports['.'];
      source = typeof entry === 'string' ? entry
        : object(entry) && typeof entry.development === 'string' ? entry.development : undefined;
    }
    if (!source) {
      for (const candidate of ['src/index.ts', 'src/index.tsx']) {
        try { await regularInside(root, candidate); source = candidate; break; }
        catch (error) { if (!object(error) || error.code !== 'ENOENT') throw error; }
      }
    }
    if (!source || !/\.tsx?$/.test(source)) throw new Error('插件没有明确的 TypeScript 工厂入口');
    projects.push({ root, id: manifest.id, name: metadata.name, version: manifest.version,
      entry: await regularInside(root, source), manifest, metadata });
  }
  if (!projects.length) throw new Error('插件发行来源不能为空');
  return projects;
}

/** 只解开真实公开 TGZ，不使用 workspace 开发条件或宿主源码别名。 */
export async function unpackPublicPackage(archive: string, directory: string): Promise<PublicReleasePackage> {
  const bytes = await readFile(archive);
  if (bytes.length > 32 * 1024 * 1024) throw new Error('公开开发包超过压缩限额');
  const tar = gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 });
  const files = new Map<string, Uint8Array>();
  for await (const entry of extract()([tar])) {
    const path = entry.header.name;
    if (entry.header.type === 'directory') continue;
    if (entry.header.type !== 'file' || !path.startsWith('package/') || path.includes('\\') ||
        path.includes('\0') || !inside(directory, resolve(directory, path.slice(8))) ||
        path.split('/').some((part) => part === '..' || part === '.' || part === '') ||
        files.has(path.slice(8))) throw new Error('公开开发包包含链接、重复身份或越界成员');
    if (files.size >= 4096) throw new Error('公开开发包文件数量超过限额');
    const chunks: Uint8Array[] = [];
    for await (const chunk of entry.body) chunks.push(chunk.subarray());
    files.set(path.slice(8), Buffer.concat(chunks));
  }
  const text = files.get('package.json');
  const metadata: unknown = text ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(text)) : null;
  if (!object(metadata) || typeof metadata.name !== 'string' ||
      !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(metadata.name) ||
      metadata.name.length > 214 || typeof metadata.version !== 'string' ||
      !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/.test(metadata.version) ||
      !object(metadata.exports) || metadata.type !== 'module') throw new Error('公开开发包缺少 ESM 出口与固定身份');
  const imports: Record<string, string> = {}, declarations: Record<string, string> = {};
  for (const [subpath, value] of Object.entries(metadata.exports)) {
    if (!/^\.(?:\/[a-zA-Z0-9._/-]+)?$/.test(subpath) || subpath.includes('..')) throw new Error('开发包出口不能使用通配或越界路径');
    const name = metadata.name + (subpath === '.' ? '' : subpath.slice(1));
    const runtime: unknown = typeof value === 'string' ? value : object(value) ? value.import ?? value.default : undefined;
    const types: unknown = object(value) ? value.types : undefined;
    const targets: readonly (readonly [unknown, Record<string, string>])[] = [[runtime, imports], [types, declarations]];
    for (const [path, target] of targets) {
      if (path === undefined) continue;
      if (typeof path !== 'string' || !path.startsWith('./') || !files.has(path.slice(2)))
        throw new Error('开发包出口指向未交付的文件');
      target[name] = resolve(directory, path);
    }
  }
  // 校验完整后才写新目录；已有目录绝不覆盖。
  await mkdir(directory, { recursive: false });
  for (const [name, body] of files) {
    const target = resolve(directory, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body, { flag: 'wx' });
  }
  return { root: directory, name: metadata.name, version: metadata.version, archive,
    bytes: bytes.length, sha256: hash(bytes), imports, declarations };
}
