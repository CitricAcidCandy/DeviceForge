import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';

assert.equal(process.platform, 'win32');
assert.deepEqual(process.argv.slice(2), []);
const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = join(root, 'artifacts', 'ai-sdk-cli-fixture-' + randomUUID());
await mkdir(directory, { recursive: true });
const sources = ['main.rs', 'windows.rs', 'evidence.rs'];
const originals = await Promise.all(sources.map(name => fileIdentity(join(root, 'scripts/ai-sdk-smoke/fixtures', name))));
for (let index = 0; index < sources.length; index++) await copyFile(originals[index].path, join(directory, sources[index]));
const binary = join(directory, 'sdk-cli.exe');
const child = spawn('rustc', ['--edition=2024', '-D', 'warnings', join(directory, 'main.rs'), '-o', binary],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const stdout = [], stderr = [];
child.stdout.on('data', chunk => stdout.push(chunk));
child.stderr.on('data', chunk => stderr.push(chunk));
const exit = await new Promise((done, reject) => { child.once('error', reject); child.once('close', (code, signal) => done({ code, signal })); });
await writeFile(join(directory, 'compile.stdout'), Buffer.concat(stdout), { flag: 'wx' });
await writeFile(join(directory, 'compile.stderr'), Buffer.concat(stderr), { flag: 'wx' });
const report = { timestamp: new Date().toISOString(), directory, originals, exit,
  source_after: await Promise.all(originals.map(entry => fileIdentity(entry.path))),
  actual: await Promise.all(sources.map(name => fileIdentity(join(directory, name)))),
  scope: '仅Rust标准库Windows原生模拟CLI编译，不启动宿主、不构建Cargo、不连接模型' };
if (exit.code === 0 && exit.signal === null) report.binary = await fileIdentity(binary);
await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
assert.deepEqual(report.source_after, originals);
assert.deepEqual(exit, { code: 0, signal: null }, '原生模拟CLI必须真实编译退出0');
console.log(JSON.stringify({ directory, binary: report.binary }));
