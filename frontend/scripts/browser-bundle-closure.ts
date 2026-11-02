import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hash, inside } from './workspace-release-inputs.ts';
import { cssReferences, javascriptReferences } from './browser-bundle-references.ts';

export const SHARED_BROWSER_IMPORTS: ReadonlySet<string> = new Set([
  'deviceforge-host', 'react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client',
]);
export interface BundleClosure {
  readonly files: readonly { readonly name: string; readonly bytes: number; readonly sha256: string }[];
  readonly sharedImports: readonly string[];
  readonly computedImports: readonly { readonly file: string; readonly position: number }[];
}

/** 这里只检查发行资源闭包；不执行脚本，也不把静态闭包称为浏览器验收。 */
export async function auditBrowserBundle(rootPath: string): Promise<BundleClosure> {
  const root = await realpath(rootPath);
  const files: { name: string; bytes: number; sha256: string }[] = [];
  const imports = new Set<string>();
  const computedImports: { file: string; position: number }[] = [];
  const graph = new Map<string, readonly string[]>();
  const workers = new Set<string>();
  async function reference(file: string, specifier: string, module: boolean): Promise<string | null> {
    if (module && SHARED_BROWSER_IMPORTS.has(specifier)) { imports.add(specifier); return null; }
    if (module && !specifier.startsWith('./') && !specifier.startsWith('../'))
      throw new Error(`浏览器产物残留未映射模块：${specifier}`);
    if (!module && /^(?:data:|#)/iu.test(specifier)) return null;
    if (specifier.includes('\\') || specifier.startsWith('/') || /^[a-z][a-z0-9+.-]*:/iu.test(specifier))
      throw new Error('浏览器产物包含不能由安装包确认的外部资源');
    const path = fileURLToPath(new URL(specifier, pathToFileURL(file)));
    if (!inside(root, path) || !inside(root, await realpath(path)) || !(await lstat(path)).isFile())
      throw new Error('浏览器产物引用了包外或不存在的资源');
    if (/\.(?:ts|tsx|mts)$/.test(path)) throw new Error('浏览器产物仍引用 TypeScript 源码');
    return path;
  }
  async function walk(directory: string, prefix: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const path = join(directory, entry.name), name = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error('浏览器构建目录不能包含链接');
      if (entry.isDirectory()) { await walk(path, `${name}/`); continue; }
      if (!entry.isFile()) throw new Error('浏览器构建目录包含非普通文件');
      const bytes = await readFile(path);
      files.push({ name, bytes: bytes.length, sha256: hash(bytes) });
      if (/\.css$/.test(entry.name)) {
        for (const resource of cssReferences(bytes.toString('utf8'))) await reference(path, resource, false);
        continue;
      }
      if (!/\.(?:mjs|js)$/.test(entry.name)) continue;
      const references = javascriptReferences(path, bytes.toString('utf8'));
      graph.set(path, references.modules);
      computedImports.push(...references.computed.map((position) => ({ file: name, position })));
      for (const specifier of references.modules) await reference(path, specifier, true);
      for (const specifier of references.assets) await reference(path, specifier, false);
      for (const specifier of references.workers) {
        const worker = await reference(path, specifier, false);
        if (!worker || !/\.(?:mjs|js)$/.test(worker)) throw new Error('Worker 入口不是实际交付的脚本资源');
        workers.add(worker);
      }
    }
  }
  await walk(root, '');
  const visited = new Set<string>();
  async function workerGraph(file: string): Promise<void> {
    if (visited.has(file)) return;
    visited.add(file);
    for (const specifier of graph.get(file) ?? []) {
      if (SHARED_BROWSER_IMPORTS.has(specifier)) throw new Error('Worker 不能借用页面 importmap 的共享模块');
      const path = await reference(file, specifier, true);
      if (path) await workerGraph(path);
    }
  }
  for (const worker of workers) await workerGraph(worker);
  if (!files.some((entry) => entry.name === 'index.js')) throw new Error('浏览器构建缺少实际 index.js');
  return { files, sharedImports: [...imports].sort(), computedImports };
}
