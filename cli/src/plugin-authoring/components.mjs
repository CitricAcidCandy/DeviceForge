// 只收集声明的构建产物；生成元数据和浏览器身份包装，不运行构建脚本。
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { inside, packagePath } from '../paths.mjs';
import { componentMetadata } from './core/component.mjs';

const reserved = new Set(['package.json', 'plugin.json', 'manifest.json', 'market.json', 'dependencies.json', '.deviceforge-entry.js']);

export async function componentMembers(base, declaration, component, dependencies, signal) {
  const directory = component.root === '.' ? base : packagePath(base, component.root);
  const root = await realpath(directory);
  if (!inside(await realpath(base), root)) throw new Error('组件目录超出开发清单所在工程');
  const members = new Map();
  let bytes = 0;
  async function collect(path, depth = 0) {
    signal?.throwIfAborted();
    const metadata = await lstat(path);
    if (depth > 32 || metadata.isSymbolicLink() || !inside(root, await realpath(path)))
      throw new Error('组件内容包含链接、越界或目录过深');
    if (metadata.isDirectory()) {
      for (const child of (await readdir(path)).sort()) await collect(join(path, child), depth + 1);
    } else {
      const name = relative(root, path).replaceAll('\\', '/');
      if (reserved.has(name)) throw new Error(`文件 ${name} 由开发清单生成，请从 files 中移除`);
      if (members.has(`package/${name}`)) return;
      bytes += metadata.size;
      if (!metadata.isFile() || bytes > 256 * 1024 * 1024 || metadata.size > 64 * 1024 * 1024 || members.size >= 20000)
        throw new Error('组件文件类型或大小超限（总256MiB、单文件64MiB、20000项）');
      members.set(`package/${name}`, await readFile(path));
    }
  }
  for (const path of component.files) await collect(packagePath(root, path));
  for (const entry of Object.values(component.entrypoints)) {
    if (!members.has(`package/${entry.path}`)) throw new Error(`组件 files 未包含入口：${entry.path}`);
  }
  for (const [path, text] of componentMetadata(declaration, component, dependencies))
    members.set('package/' + path, Buffer.from(text));
  return members;
}
