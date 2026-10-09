import { copyFile, mkdir, lstat, readdir, realpath, chmod } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { inside } from './paths.mjs';

export async function copyPackage(source, destination, signal) {
  const root = await realpath(source);
  let bytes = 0; let files = 0;
  async function copy(from, to, depth) {
    signal?.throwIfAborted();
    if (depth > 32) throw new Error('插件目录深度超过 32');
    const metadata = await lstat(from);
    if (metadata.isSymbolicLink() || !inside(root, await realpath(from))) throw new Error('插件包不能包含链接或越界路径');
    if (metadata.isDirectory()) {
      await mkdir(to);
      for (const entry of await readdir(from)) {
        if (entry === '.git') continue;
        if (basename(from) === 'node_modules' && entry === '.bin') continue;
        // npm 自身状态文件不进入部署；node_modules 作为运行依赖需要保留。
        await copy(join(from, entry), join(to, entry), depth + 1);
      }
    } else if (metadata.isFile()) {
      bytes += metadata.size; files += 1;
      if (bytes > 256 * 1024 * 1024 || files > 20000) throw new Error('插件包超过 256 MiB 或 20000 文件上限');
      await copyFile(from, to);
      if (process.platform !== 'win32') await chmod(to, metadata.mode & 0o777);
    } else throw new Error('插件包包含非普通文件');
  }
  await copy(root, destination, 0);
  return { bytes, files };
}
