import { lstat, readFile, realpath } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { HOST_IMPORTS } from './types.js';
import type { BrowserPluginBuildOptions, BuildInput } from './types.js';

export function inside(root: string, path: string): boolean {
  const value = relative(root, path);
  return value === '' || value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function codePath(value: string): string { return value.replaceAll('\\', '/'); }

async function existingLocation(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if (!record(error) || error.code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await existingLocation(parent), relative(parent, path));
  }
}
async function packageRoot(file: string, expected: string): Promise<string> {
  let folder = dirname(file);
  while (true) {
    try {
      const value: unknown = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8'));
      if (!record(value) || value.name !== expected)
        throw new Error(`公开模块必须属于同名发行包：${expected}`);
      return folder;
    } catch (error) {
      if (!record(error) || error.code !== 'ENOENT') throw error;
    }
    const parent = dirname(folder);
    if (parent === folder) throw new Error(`公开模块缺少发行包身份：${expected}`);
    folder = parent;
  }
}
export function sharedModule(id: string): boolean { return HOST_IMPORTS.some((value) => value === id); }
export function rejectUnknownSharedModule(id: string): void {
  if (!sharedModule(id) && /^(?:react|react-dom)(?:\/|$)/u.test(id))
    throw new Error(`宿主 importmap 未提供此共享 React 子路径：${id}`);
}
export async function validateInput(options: BrowserPluginBuildOptions): Promise<BuildInput> {
  options.signal?.throwIfAborted();
  if (!options.root || !options.outputDir) throw new Error('必须显式提供工程 root 和输出 outputDir');
  const root = await realpath(resolve(options.root));
  if (!(await lstat(root)).isDirectory()) throw new Error('工程 root 必须是目录');
  const candidate = options.entry ? resolve(root, options.entry) : join(root, 'src', 'index.ts');
  let entry: string;
  try { entry = await realpath(candidate); }
  catch (error) {
    if (options.entry || !record(error) || error.code !== 'ENOENT') throw new Error('插件入口不存在', { cause: error });
    try { entry = await realpath(join(root, 'src', 'index.tsx')); }
    catch (reason) { throw new Error('插件入口必须存在：src/index.ts 或 src/index.tsx', { cause: reason }); }
  }
  if (!inside(root, entry) || !/\.[cm]?[jt]sx?$/u.test(entry) || !(await lstat(entry)).isFile())
    throw new Error('插件入口必须是工程内的 JavaScript 或 TypeScript 文件');
  const outputDir = await existingLocation(resolve(root, options.outputDir));
  if (outputDir === root || !inside(root, outputDir) || inside(outputDir, entry) ||
      codePath(relative(root, outputDir)).split('/').some((part) => ['node_modules', '.git'].includes(part)))
    throw new Error('输出目录必须位于工程内，且不得覆盖工程、入口或依赖目录');
  const dependencies: Record<string, string> = {}, dependencyRoots = new Set<string>();
  for (const [specifier, input] of Object.entries(options.dependencies ?? {})) {
    if (!/^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._/-]+)?$/u.test(specifier) ||
        specifier.split('/').some((part) => part === '.' || part === '..') || isBuiltin(specifier))
      throw new Error(`公开依赖说明符无效：${specifier}`);
    rejectUnknownSharedModule(specifier);
    if (sharedModule(specifier)) throw new Error(`共享模块不得通过依赖映射覆盖：${specifier}`);
    if (!isAbsolute(input)) throw new Error(`公开依赖模块须为绝对路径：${specifier}`);
    const target = await realpath(input);
    if (!['.js', '.mjs', '.cjs', '.json', '.css'].includes(extname(target)) || !(await lstat(target)).isFile())
      throw new Error(`公开依赖必须提供已发行的 ESM、JSON 或 CSS 模块：${specifier}`);
    const parts = specifier.split('/'), name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    if (!name) throw new Error('公开依赖包身份缺失');
    dependencyRoots.add(await packageRoot(target, name));
    dependencies[specifier] = target;
  }
  const theme = options.theme ?? '';
  if (typeof theme !== 'string' || Buffer.byteLength(theme, 'utf8') > 512 * 1024 ||
      theme.includes('\0') || /@(?:import|source)\b|url\s*\(/iu.test(theme))
    throw new Error('公开主题仅接受有界 Tailwind 主题和变体文本，不接受额外导入或扫描目录');
  options.signal?.throwIfAborted();
  return { root, entry, outputDir, dependencies, dependencyRoots: [...dependencyRoots], theme };
}
