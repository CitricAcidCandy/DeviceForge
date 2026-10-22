// 流式核验普通文件；本地产物路径不进入发布清单。
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath, readFile } from 'node:fs/promises';
import { relative, isAbsolute, sep } from 'node:path';
import { RESOURCE_LIMIT } from './contract.mjs';

export async function measureFile(path, limit = RESOURCE_LIMIT) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > limit)
    throw new Error('发布源必须为有界非链接普通文件');
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    size += chunk.length;
    if (size > limit) throw new Error('发布源超过读取上限');
    hash.update(chunk);
  }
  if (size !== stat.size) throw new Error('发布源核验期间字节大小发生变化');
  return { size, sha256: hash.digest('hex') };
}
export async function verifyFile(path, descriptor) {
  const measured = await measureFile(path);
  if (measured.size !== descriptor.size || measured.sha256 !== descriptor.sha256)
    throw new Error('发布源实际归档与声明摘要或大小不符');
  return measured;
}
export async function readJson(path, limit = 256 * 1024) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit)
    throw new Error('发布 JSON 必须为有界普通文件');
  return JSON.parse(await readFile(path, 'utf8'));
}
export async function assertWithin(root, target) {
  const root_ = await realpath(root),
    target_ = await realpath(target);
  const path = relative(root_, target_);
  if (isAbsolute(path) || path === '..' || path.startsWith('..' + sep))
    throw new Error('本次发布暂存路径越界');
}
