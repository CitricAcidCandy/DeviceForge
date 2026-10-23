// 官方已取得的完整工具闭包；摘要固定，库存生成时再次流式核对实际文件与入口。
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyFile } from './io.mjs';
import { verifyEntries } from './archive.mjs';
import { jsonBytes } from './pack.mjs';

const tool = (file, version, format, sha256, size, entries, platform = 'win32-x64') => ({
  file,
  platform,
  version,
  format,
  sha256,
  size,
  entries,
});
const fridaFile = 'frida-runtime/frida-17.24.3-tools-14.11.0-python-3.12.10-win32-x64.zip';
const fridaHash = '1cd6e9cfa0369dc41e758ed02d812829f14d0f98bcc64b5ac01ae5111983de18';
export const officialTools = {
  adb: tool(
    'platform-tools-36.0.0-local-repack.zip',
    '36.0.0',
    'zip',
    'c6d0b5d28fd0a1da5d49524180ac8aea5c6d72de4344bd2e9919557c1b23b730',
    15394297,
    { adb: 'platform-tools/adb.exe' },
  ),
  scrcpy: tool(
    'scrcpy-win64-v3.3.4.zip',
    '3.3.4',
    'zip',
    'd8a155b7c180b7ca4cdadd40712b8750b63f3aab48cb5b8a2a39ac2d0d4c5d38',
    7287033,
    { scrcpy: 'scrcpy-win64-v3.3.4/scrcpy.exe' },
  ),
  'scrcpy-server': tool(
    'scrcpy-server-v3.3.4',
    '3.3.4',
    'file',
    '8588238c9a5a00aa542906b6ec7e6d5541d9ffb9b5d0f6e1bc0e365e2303079e',
    90980,
    { server: 'payload' },
    'any',
  ),
  node: tool(
    'official-tools/node-v24.14.0-win-x64.zip',
    '24.14.0',
    'zip',
    '313fa40c0d7b18575821de8cb17483031fe07d95de5994f6f435f3b345f85c66',
    36217529,
    { node: 'node-v24.14.0-win-x64/node.exe' },
  ),
  'codex-sdk': tool(
    'official-tools/codex-sdk-0.162.1.tgz',
    '0.162.1',
    'tgz',
    'ae10b9096bb72ebdf1fbac598fd87960afc1ddf5b8980fa0d38bdd6770400349',
    21406,
    { sdk: 'package/dist/index.js' },
  ),
  'codex-cli': tool(
    'official-tools/codex-0.162.1-win32-x64.tgz',
    '0.162.1',
    'tgz',
    '5d48824f11a512b0ecb351461c2e90a1040c80de1026bc4a80815d5121f3936d',
    165053495,
    { codex: 'package/vendor/x86_64-pc-windows-msvc/bin/codex.exe' },
  ),
  hdc: tool(
    'hdc-tools/hdc-5.0.0.71-win32-x64-local-repack.zip',
    '5.0.0.71',
    'zip',
    '9deca0ba3f3720779bffe9073a370eb2bfd47d85809d25ea522c2f8f3f03c79d',
    5470245,
    { hdc: 'hdc.exe' },
  ),
  frida: tool(fridaFile, '17.24.3', 'zip', fridaHash, 204690333, { frida: 'frida.exe' }),
  'frida-ps': tool(fridaFile, '17.24.3', 'zip', fridaHash, 204690333, {
    'frida-ps': 'frida-ps.exe',
  }),
};

export async function writeToolInventory(
  directory,
  destination = join(directory, 'tool-inventory.json'),
) {
  const checked = new Map(),
    reports = [];
  for (const [id, declaration] of Object.entries(officialTools)) {
    const file = resolve(directory, declaration.file);
    if (!checked.has(declaration.sha256)) {
      await verifyFile(file, declaration);
      checked.set(declaration.sha256, await verifyEntries(file, declaration, { collect: false }));
    }
    const members = checked.get(declaration.sha256);
    if (!Object.values(declaration.entries).every((entry) => members.has(entry)))
      throw new Error(`工具入口不存在：${id}`);
    reports.push({
      id,
      members: members.size,
      expanded_bytes: [...members.values()].reduce((sum, item) => sum + item.size, 0),
    });
  }
  const inventory = {
    format_version: 1,
    platform: 'win32-x64',
    tools: officialTools,
    optional_tools_omitted: [
      'java',
      'apkanalyzer',
      'apksigner',
      'bundletool',
      'apktool',
      'input-trace',
    ],
    reports,
    device_verified: false,
    published: false,
  };
  await writeFile(destination, jsonBytes(inventory), { flag: 'wx' });
  return inventory;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = resolve(process.argv[2] ?? 'artifacts/plugin-release-candidates-20261022');
  console.log(JSON.stringify(await writeToolInventory(directory), null, 2));
}
