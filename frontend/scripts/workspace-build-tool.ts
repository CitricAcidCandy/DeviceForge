import { lstat, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const semver: unknown = createRequire(import.meta.url)('semver');
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export interface WorkspaceBuildTool {
  readonly name: '@deviceforge/plugin-tools';
  readonly version: string;
  readonly archive: string;
  readonly content: Buffer;
}

function validVersion(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() !== value || !/^[0-9]/u.test(value) ||
      !object(semver) || typeof semver.valid !== 'function') return false;
  const normalized: unknown = semver.valid(value);
  return typeof normalized === 'string';
}

/** 只发现已发行工具的真实版本与字节，不构建、不发行，也不猜测旧归档。 */
export async function readWorkspaceBuildTool(frontend: string): Promise<WorkspaceBuildTool> {
  const root = join(resolve(frontend), 'plugin-tools');
  let metadata: unknown;
  try { metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')); }
  catch (error) { throw new Error('无法读取构建工具元数据 package.json', { cause: error }); }
  if (!object(metadata) || metadata.name !== '@deviceforge/plugin-tools')
    throw new Error('构建工具包身份必须为 @deviceforge/plugin-tools');
  if (!validVersion(metadata.version))
    throw new Error('构建工具版本必须为完整有效的 semver，不接受前缀、范围或路径');
  const archive = join(root, 'dist', `deviceforge-plugin-tools-${metadata.version}.tgz`);
  try {
    if (!(await lstat(archive)).isFile()) throw new Error('构建工具归档必须是普通文件');
    return { name: metadata.name, version: metadata.version, archive, content: await readFile(archive) };
  } catch (error) {
    throw new Error(`无法读取构建工具归档 ${metadata.version} 的普通文件：${archive}`, { cause: error });
  }
}
