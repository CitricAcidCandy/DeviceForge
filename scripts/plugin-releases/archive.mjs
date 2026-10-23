// 归档入口只负责格式分派；具体读取和写入规则分别位于独立模块。
import { lstat, readFile } from 'node:fs/promises';
import { RESOURCE_LIMIT } from './contract.mjs';
import { BUFFER_LIMIT, fail } from './archive-common.mjs';
import { zipMembers } from './archive-zip.mjs';
import { tarMembers } from './archive-tar.mjs';

export { writeZip, writeTgz } from './archive-write.mjs';

export async function archiveMembers(path, format, options = {}) {
  if (format === 'file') {
    const stat = await lstat(path);
    fail(
      stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= RESOURCE_LIMIT,
      '单文件工具大小或类型无效',
    );
    if (options.collect === false) return new Map([['payload', { size: stat.size }]]);
    fail(stat.size <= BUFFER_LIMIT, '需要读取正文的资源超过256MiB');
    return new Map([['payload', await readFile(path)]]);
  }
  if (format === 'zip') return zipMembers(path, options);
  if (format === 'tgz') return tarMembers(path, options);
  throw new Error('不支持的发布归档格式');
}

export async function verifyEntries(path, variant, options = {}) {
  const members = await archiveMembers(path, variant.format, options);
  for (const entry of Object.values(variant.entries ?? {}))
    fail(members.has(entry), `工具资源入口不存在：${entry}`);
  return members;
}
