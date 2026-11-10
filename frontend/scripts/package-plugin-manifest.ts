import { mkdir, lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { pack } from 'it-tar';
import { hash, inside, object } from './workspace-release-inputs.ts';

const publicFiles = [
  'component.mjs', 'configuration.mjs', 'contract.mjs', 'dependencies.mjs',
  'encoding.mjs', 'index.d.ts', 'index.mjs', 'manifest.mjs', 'market.mjs',
  'package.json', 'README.md', 'versions.mjs',
] as const;

/** 只定位CLI已经公开的纯规则包，不开放其他宿主目录。 */
export function pluginManifestRoot(): string {
  return resolve(import.meta.dirname, '../../cli/src/plugin-authoring/core');
}

export interface ManifestPackageResult {
  readonly root: string;
  readonly archive: string;
  readonly version: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly files: readonly string[];
}

/** 从当前公共源码生成可独立消费的归档，不读取SDK旧缓存或启动npm。 */
export async function packagePluginManifest(outputRoot: string): Promise<ManifestPackageResult> {
  const source = pluginManifestRoot();
  const information = await lstat(source);
  if (!information.isDirectory() || information.isSymbolicLink()) throw new Error('清单公开包必须是当前普通目录');
  const root = await realpath(source);
  const output = resolve(outputRoot);
  if (output === root || inside(root, output)) throw new Error('清单归档不能写入公开源码目录');
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.length !== publicFiles.length || entries.some((entry) =>
    !entry.isFile() || !publicFiles.some((name) => name === entry.name)))
    throw new Error('清单公开包文件集合与明确发行范围不一致');
  const contents = new Map<string, Buffer>();
  for (const name of publicFiles) {
    const file = join(root, name);
    const state = await lstat(file);
    if (!state.isFile() || state.isSymbolicLink() || relative(root, file) !== name)
      throw new Error('清单公开包只能发行所属普通文件');
    contents.set(name, await readFile(file));
  }
  const metadata: unknown = JSON.parse(contents.get('package.json')?.toString('utf8') ?? 'null');
  if (!object(metadata) || metadata.name !== '@deviceforge/plugin-manifest' || metadata.version !== '0.1.0' ||
      metadata.private !== true || metadata.type !== 'module' || !object(metadata.exports) ||
      Object.keys(metadata.exports).length !== 1 || !object(metadata.exports['.']) ||
      metadata.exports['.'].types !== './index.d.ts' || metadata.exports['.'].default !== './index.mjs' ||
      !object(metadata.dependencies) || Object.keys(metadata.dependencies).length !== 1 ||
      metadata.dependencies.semver !== '7.8.5')
    throw new Error('清单公开包身份、出口或依赖与本批支持范围不一致');
  const chunks: Uint8Array[] = [];
  for await (const chunk of pack()([...contents].map(([name, body]) => ({
    header: { name: `package/${name}`, size: body.length, mode: 0o644, uid: 0, gid: 0, mtime: new Date(0) }, body,
  })))) chunks.push(chunk);
  const bytes = gzipSync(Buffer.concat(chunks), { level: 9 });
  await mkdir(output, { recursive: true });
  const archive = join(output, `deviceforge-plugin-manifest-${metadata.version}.tgz`);
  await writeFile(archive, bytes);
  return { root, archive, version: metadata.version, sha256: hash(bytes), bytes: bytes.length, files: publicFiles };
}
