import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zip } from './archive.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
export const componentFiles = {
  browser: ['package.json', 'plugin.json', 'README.md', 'src/index.js', 'src/echo.js', 'src/mount.js', 'src/debugger-client.js'],
  server: ['package.json', 'plugin.json', 'README.md', 'entry.mjs', 'protocol.mjs'],
};
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function buildPackages(root = sourceRoot) {
  const outputs = [];
  const components = [];
  const blobs = [];
  for (const kind of ['browser', 'server']) {
    const entries = await Promise.all(componentFiles[kind].map(async (path) =>
      [path, await readFile(join(root, kind, path))]));
    const descriptor = JSON.parse(entries.find(([path]) => path === 'package.json')[1].toString('utf8'));
    const manifest = JSON.parse(entries.find(([path]) => path === 'plugin.json')[1].toString('utf8'));
    if (descriptor.version !== manifest.version || descriptor.deviceforge.kind !== kind)
      throw new Error('包身份或版本不一致');
    const bytes = zip(entries);
    const sha256 = digest(bytes);
    outputs.push({ filename: `${kind}.zip`, bytes });
    components.push({ id: manifest.id, kind, version: manifest.version,
      variants: [{ platform: 'any', path: `blobs/${sha256}`, sha256, size: bytes.length, format: 'zip' }] });
    blobs.push([`blobs/${sha256}`, bytes]);
  }
  // 无工具依赖的成套包使用公开 v1 兼容格式；Node 运行时由部署者提供。
  const release = { format_version: 1, host_api_version: 2, id: 'demo-debugger-suite', version: '1.0.0',
    name: '独立 Debugger 回显示例', description: '原生 ESM 与无 SDK Node 协议回显，不访问设备',
    components, tools: [], requirements: [] };
  const manifestBytes = Buffer.from(JSON.stringify(release, null, 2) + '\n');
  outputs.push({ filename: 'debugger-demo.zip', bytes: zip([['release.json', manifestBytes], ...blobs]) });
  const checksums = outputs.map(({ filename, bytes }) => ({ filename, size: bytes.length, sha256: digest(bytes) }));
  return { outputs, checksums, release };
}

export async function writePackages(output = join(sourceRoot, 'dist'), root = sourceRoot) {
  const built = await buildPackages(root);
  await mkdir(output, { recursive: true });
  // 不覆盖用户同名文件；需要重复打包时选择新的输出目录。
  for (const item of built.outputs) await writeFile(join(output, item.filename), item.bytes, { flag: 'wx' });
  await writeFile(join(output, 'checksums.json'), JSON.stringify(built.checksums, null, 2) + '\n', { flag: 'wx' });
  return built.checksums;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv[2] ? resolve(process.argv[2]) : join(sourceRoot, 'dist');
  await mkdir(dirname(output), { recursive: true });
  console.log(JSON.stringify(await writePackages(output), null, 2));
}
