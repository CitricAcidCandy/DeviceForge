import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { pack } from 'it-tar';
import { sdkBrowserPackage } from './sdk-repository.ts';

export type InstalledSdkName = 'sdk' | 'tools' | 'contracts';
const names = { sdk: '@deviceforge/plugin-sdk', tools: '@deviceforge/plugin-tools', contracts: '@deviceforge/contracts' } as const;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const inside = (root: string, path: string): boolean => {
  const part = relative(root, path);
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
};

/** 仅重封已安装公开包的真实发行文件，不编译源码；归档字节不冒充原下载TGZ。 */
export async function archiveInstalledSdkPackage(
  frontend: string, name: InstalledSdkName, outputRoot: string,
) {
  const root = sdkBrowserPackage(frontend, name);
  const output = resolve(outputRoot);
  if (output === root || inside(root, output)) throw new Error('重新归档不得写入已安装公开包');
  const metadataBytes = await readFile(join(root, 'package.json'));
  const metadata: unknown = JSON.parse(metadataBytes.toString('utf8'));
  if (!object(metadata) || metadata.name !== names[name] || typeof metadata.version !== 'string' ||
      !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/.test(metadata.version) ||
      !Array.isArray(metadata.files) || metadata.files.length === 0)
    throw new Error('已安装公开包缺少固定身份、版本或发行文件清单');
  const contents = new Map<string, Buffer>([['package.json', metadataBytes]]);
  let total = metadataBytes.length;
  async function collect(name: string): Promise<void> {
    if (name.includes('\\') || name.includes('\0') || name.split('/').some((part) => !part || part === '.' || part === '..'))
      throw new Error('已安装公开包发行文件越界');
    const path = resolve(root, name);
    if (!inside(root, path)) throw new Error('已安装公开包发行文件越界');
    const state = await lstat(path);
    if (state.isDirectory()) {
      for (const entry of await readdir(path)) await collect(`${name}/${entry}`);
      return;
    }
    if (!state.isFile()) throw new Error('已安装公开包发行文件不能包含链接或特殊文件');
    if (contents.has(name)) return;
    total += state.size;
    if (contents.size >= 4096 || total > 64 * 1024 * 1024) throw new Error('已安装公开包发行文件超过限额');
    contents.set(name, await readFile(path));
  }
  for (const file of metadata.files) {
    if (typeof file !== 'string' || /[*?\[\]{}]/u.test(file)) throw new Error('发行文件清单必须使用明确相对文件或目录');
    await collect(file);
  }
  const files = [...contents.keys()].sort((left, right) => left.localeCompare(right, 'en'));
  const entries = files.map((name) => {
    const body = contents.get(name);
    if (!body) throw new Error('发行文件在收集后缺失');
    return { header: { name: `package/${name}`, size: body.length, mode: 0o644, uid: 0, gid: 0, mtime: new Date(0) }, body };
  });
  const chunks: Uint8Array[] = [];
  for await (const chunk of pack()(entries)) chunks.push(chunk);
  const bytes = gzipSync(Buffer.concat(chunks), { level: 9 });
  const archive = join(output, `${names[name].replace(/^@/u, '').replaceAll('/', '-')}-${metadata.version}.tgz`);
  await mkdir(dirname(archive), { recursive: true });
  try {
    await writeFile(archive, bytes, { flag: 'wx' });
  } catch (cause) {
    if (!object(cause) || cause.code !== 'EEXIST' || !(await readFile(archive)).equals(bytes)) throw cause;
  }
  return { name: names[name], version: metadata.version, archive, sourceRoot: root,
    source: 'installed_package_rearchive' as const, bytes: bytes.length, sha256: digest(bytes), files,
    members: entries.map((entry) => ({ name: entry.header.name.slice(8), sha256: digest(entry.body) })),
  };
}
