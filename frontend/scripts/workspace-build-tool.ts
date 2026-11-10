import { lstat, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { sdkBrowserPackage } from './sdk-repository.ts';
import { archiveInstalledSdkPackage } from './installed-sdk-package.ts';

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

/** 默认重封已安装工具发行文件；显式目录仅用于校验测试归档，不寻找SDK源码。 */
export async function readWorkspaceBuildTool(frontend: string, packageRoot?: string): Promise<WorkspaceBuildTool> {
  const root = packageRoot ? resolve(packageRoot) : sdkBrowserPackage(frontend, 'tools');
  let metadata: unknown;
  try { metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')); }
  catch (error) { throw new Error('无法读取构建工具元数据 package.json', { cause: error }); }
  if (!object(metadata) || metadata.name !== '@deviceforge/plugin-tools')
    throw new Error('构建工具包身份必须为 @deviceforge/plugin-tools');
  if (!validVersion(metadata.version))
    throw new Error('构建工具版本必须为完整有效的 semver，不接受前缀、范围或路径');
  const archive = packageRoot ? join(root, 'dist', `deviceforge-plugin-tools-${metadata.version}.tgz`)
    : (await archiveInstalledSdkPackage(frontend, 'tools', join(frontend, 'artifacts/installed-sdk'))).archive;
  try {
    if (!(await lstat(archive)).isFile()) throw new Error('构建工具归档必须是普通文件');
    return { name: metadata.name, version: metadata.version, archive, content: await readFile(archive) };
  } catch (error) {
    throw new Error(`无法读取构建工具归档 ${metadata.version} 的普通文件：${archive}`, { cause: error });
  }
}
