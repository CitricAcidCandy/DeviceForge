// Frida 便携目录与透明启动器一并归档，缓存和构建机器路径不进入公开闭包。
import { readdir, lstat, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeZip, archiveMembers } from './archive.mjs';
import { measureFile } from './io.mjs';

const root = resolve(process.argv[2] ?? 'artifacts/plugin-release-candidates-20261022/frida-runtime'),
  directory = join(root, 'frida-17.24.3-tools-14.11.0-win32-x64'),
  downloads = JSON.parse(await readFile(join(root, 'download-report.json'))),
  provenance = downloads.map(({ file, ...item }) => item);
const execute = promisify(execFile),
  version = (await execute(join(directory, 'frida.exe'), ['--version'], { timeout: 30000, windowsHide: true })).stdout.trim(),
  help = (await execute(join(directory, 'frida-ps.exe'), ['--help'], { timeout: 30000, windowsHide: true })).stdout;
if (version !== '17.24.3' || !help.includes('--applications') || !help.includes('--json')) throw new Error('Frida 便携启动入口验收失败');
await writeFile(join(directory, '来源与许可.json'), JSON.stringify({
  tools: provenance,
  launcher: { source: 'frida-launcher.rs', compiler: 'rustc 1.94.0 x86_64-pc-windows-msvc', command: 'rustc --edition 2024 --crate-name deviceforge_frida_launcher -C opt-level=2 -C debuginfo=0 frida-launcher.rs -o frida.exe' },
}, null, 2) + '\n');
await writeFile(join(directory, 'frida-launcher.rs'), await readFile(new URL('./frida-launcher.rs', import.meta.url)), { flag: 'wx' });
const members = [];
async function visit(prefix = '') {
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    if (entry.name === '__pycache__' || entry.name.endsWith('.pyc')) continue;
    const name = prefix ? `${prefix}/${entry.name}` : entry.name,
      path = join(directory, name), stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error('Frida 目录含符号链接');
    if (stat.isDirectory()) await visit(name);
    else if (stat.isFile()) members.push({ name, path });
    else throw new Error('Frida 目录含特殊文件');
  }
}
await visit();
for (const name of ['frida.exe', 'frida-ps.exe', 'python/python.exe', 'python/LICENSE.txt', 'site-packages/frida/_frida.pyd', 'site-packages/frida_tools/repl.py', 'site-packages/frida_tools/ps.py'])
  if (!members.some((member) => member.name === name)) throw new Error(`Frida 闭包缺文件：${name}`);
const archive = join(root, 'frida-17.24.3-tools-14.11.0-python-3.12.10-win32-x64.zip');
await writeZip(archive, members);
const actual = await archiveMembers(archive, 'zip', { collect: false });
const report = {
  version: '17.24.3', tools_version: '14.11.0', python_version: '3.12.10',
  archive, ...await measureFile(archive), members: actual.size,
  expanded_bytes: [...actual.values()].reduce((sum, value) => sum + value.size, 0),
  entries: { frida: 'frida.exe', 'frida-ps': 'frida-ps.exe' },
  smoke: { frida_version: version, frida_ps_help: true, device_connected: false },
  source_urls: provenance.map((item) => item.url),
};
await writeFile(join(root, 'pack-report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report, null, 2));
