import { copyFile, lstat, mkdir, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { inside, record } from './paths.js';
import type { BrowserPluginBuildResult } from './types.js';

export const digest = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const absent = (error: unknown) => record(error) && error.code === 'ENOENT';
function ownedPath(value: string): boolean {
  return value !== '' && !value.includes('\\') && !value.startsWith('/') &&
    value.split('/').every((part) => part !== '.' && part !== '..' && part !== '');
}
async function previousFiles(outputDir: string): Promise<ReadonlySet<string>> {
  try {
    const path = join(outputDir, 'plugin-build.json');
    if ((await lstat(path)).isSymbolicLink()) throw new Error('构建归属报告不能是链接');
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!record(value) || value.formatVersion !== 1 || value.outputDir !== outputDir || !record(value.tool) ||
        value.tool.name !== '@deviceforge/plugin-tools' || !Array.isArray(value.files))
      throw new Error('旧构建归属报告无效，不覆盖原产物');
    const paths = new Set<string>(['plugin-build.json']);
    for (const file of value.files) {
      if (!record(file) || typeof file.path !== 'string' || !ownedPath(file.path))
        throw new Error('旧构建归属路径无效，不覆盖原产物');
      paths.add(file.path);
    }
    return paths;
  } catch (error) {
    if (absent(error)) return new Set();
    throw error;
  }
}
async function checkedParents(outputDir: string, target: string): Promise<void> {
  let folder = dirname(target);
  while (inside(outputDir, folder)) {
    try {
      const stat = await lstat(folder);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('输出目录不得经过链接或非目录');
    } catch (error) { if (!absent(error)) throw error; }
    if (folder === outputDir) break;
    folder = dirname(folder);
  }
}

/** 不清空目录；只替换本工具已有产物，失败时回滚本次改动，无关文件和旧块均保留。 */
export async function commitOutput(stage: string, result: BrowserPluginBuildResult, signal: AbortSignal): Promise<void> {
  const owned = await previousFiles(result.outputDir);
  const planned = [...result.files.map((file) => file.path), result.reportFile];
  const originals = new Map<string, string>(), created = new Set<string>();
  const backups = join(stage, '.previous-output');
  for (const path of planned) {
    signal.throwIfAborted();
    if (!ownedPath(path)) throw new Error('构建输出路径越界');
    const target = join(result.outputDir, path);
    await checkedParents(result.outputDir, target);
    try {
      const stat = await lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`输出目标不是普通文件：${path}`);
      if (!owned.has(path)) {
        const existing = await readFile(target), next = await readFile(join(stage, path));
        if (digest(existing) !== digest(next)) throw new Error(`拒绝覆盖归属未知的旧产物：${path}`);
      }
      const backup = join(backups, path);
      await mkdir(dirname(backup), { recursive: true }); await copyFile(target, backup);
      originals.set(path, backup);
    } catch (error) { if (!absent(error)) throw error; created.add(path); }
  }
  const written: string[] = [];
  try {
    for (const path of planned) {
      signal.throwIfAborted();
      const target = join(result.outputDir, path);
      await checkedParents(result.outputDir, target);
      await mkdir(dirname(target), { recursive: true });
      // 暂存可能位于另一磁盘，先复制到目标同目录，再做同卷原子替换。
      const local = join(dirname(target), `.deviceforge-write-${randomUUID()}`);
      try {
        await copyFile(join(stage, path), local, constants.COPYFILE_EXCL);
        signal.throwIfAborted();
        await rename(local, target); written.push(path);
      } finally {
        try { await unlink(local); } catch (error) { if (!absent(error)) throw error; }
      }
    }
    signal.throwIfAborted();
  } catch (error) {
    const failures: unknown[] = [error];
    for (const path of written.reverse()) {
      try {
        const original = originals.get(path), target = join(result.outputDir, path);
        if (original) await copyFile(original, target);
        else if (created.has(path)) await unlink(target);
      } catch (failure) { failures.push(failure); }
    }
    if (failures.length > 1) throw new AggregateError(failures, '构建提交失败，部分原产物回滚也失败');
    throw error;
  }
}
