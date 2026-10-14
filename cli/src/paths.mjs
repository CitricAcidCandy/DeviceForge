import { lstat, realpath, readFile, rename } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export function inside(root, path) {
  const difference = relative(root, path);
  return (
    difference === '' ||
    (!difference.startsWith(`..${sep}`) && difference !== '..' && !isAbsolute(difference))
  );
}
export function packagePath(root, value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('\\') ||
    value.includes(':') ||
    value.startsWith('/') ||
    value.split('/').some((part) => ['.', '..', ''].includes(part))
  )
    throw new Error('包内路径必须为不含越界的相对路径');
  const path = resolve(root, value);
  if (!inside(root, path)) throw new Error('包内路径越界');
  return path;
}
export async function regularFile(root, value) {
  const path = packagePath(root, value);
  const metadata = await lstat(path);
  const canonicalRoot = await realpath(root);
  const canonicalPath = await realpath(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || !inside(canonicalRoot, canonicalPath))
    throw new Error('包内入口必须为非链接普通文件');
  return path;
}
export async function readJson(path, limit = 65536) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > limit)
    throw new Error('清单必须为受限普通 JSON 文件');
  return JSON.parse(await readFile(path, 'utf8'));
}

// Windows 刚复制的程序可能短暂被扫描器占用，只对瞬时共享冲突有限重试。
export async function atomicRename(source, destination) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 6) throw error;
      await delay(50 * 2 ** attempt);
    }
  }
}
