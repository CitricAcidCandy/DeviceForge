// 串行消费同一批冻结程序，记录真实退出码；任一失败立即保留现场。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let profile = 'debug',
  binaryDirectory,
  only;
for (let index = 0; index < args.length; index++) {
  const value = args[index];
  if (value === '--release') profile = 'release';
  else if (value === '--binary-directory') binaryDirectory = resolve(args[++index]);
  else if (value === '--only') only = args[++index].split(',');
  else throw new Error(`未知验收参数：${value}`);
}
binaryDirectory ??= join(root, 'backend', 'target', profile);
const suffix = profile === 'release' ? ['--release'] : [];
const suites = [
  ['runtime', 'backend', 'scripts/runtime-smoke.mjs', []],
  ['runtime-performance', 'backend', 'scripts/runtime-smoke.mjs', ['--performance-plugin']],
  ['logging', 'backend', 'scripts/logging-smoke.mjs', ['--functional-only']],
  ['lifecycle', 'backend', 'scripts/plugin-lifecycle-smoke.mjs', []],
  ['cooperative', 'backend', 'scripts/cooperative-smoke.mjs', []],
  ['online', 'backend', 'scripts/online-plugins-smoke.mjs', []],
  ['provider', '.', 'scripts/device-provider-smoke.mjs', []],
  ['nested', '.', 'scripts/nested-device-artifacts-smoke.mjs', []],
  ['browser', '.', 'scripts/browser-plugin-smoke.mjs', []],
];
if (only) assert.ok(only.length && only.every((name) => suites.some(([id]) => id === name)));
const output = join(root, 'artifacts', `unified-release-gates-${profile}-${Date.now()}`);
await mkdir(output);
const report = {
  timestamp: new Date().toISOString(),
  profile,
  binary_directory: binaryDirectory,
  scope: '同一批原生程序的真实服务功能门禁；性能插件仅验证协议，不作性能结论',
  programs: [],
  suites: [],
  passed: false,
};
for (const name of (await readdir(binaryDirectory))
  .filter((name) => name.endsWith('.exe'))
  .sort()) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const bytes of createReadStream(join(binaryDirectory, name))) {
    hash.update(bytes);
    size += bytes.length;
  }
  report.programs.push({ name, size, sha256: hash.digest('hex') });
}
assert.ok(report.programs.some(({ name }) => name === 'apk-server.exe'));
const save = () => writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
await save();
for (const [id, cwd, script, extra] of suites.filter(([id]) => !only || only.includes(id))) {
  const entry = { id, started_at: new Date().toISOString(), log: join(output, `${id}.log`) };
  report.suites.push(entry);
  await save();
  console.log(`开始 ${profile} 门禁：${id}`);
  const log = createWriteStream(entry.log, { flags: 'wx' });
  const child = spawn(process.execPath, [script, ...suffix, ...extra], {
    cwd: resolve(root, cwd),
    windowsHide: true,
    env: { ...process.env, DEVICEFORGE_SMOKE_BINARY_DIR: binaryDirectory },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  child.on('error', (error) => {
    entry.error = error.message;
  });
  await new Promise((done) =>
    child.once('close', (code, signal) => {
      entry.exit_code = code;
      entry.signal = signal;
      done();
    }),
  );
  await new Promise((done) => log.end(done));
  entry.completed_at = new Date().toISOString();
  entry.passed = entry.exit_code === 0 && !entry.error;
  await save();
  if (!entry.passed) {
    console.error((await readFile(entry.log, 'utf8')).slice(-10000));
    process.exitCode = 1;
    break;
  }
  console.log(`通过 ${profile} 门禁：${id}`);
}
report.completed_at = new Date().toISOString();
report.passed = report.suites.length > 0 && report.suites.every((entry) => entry.passed);
await save();
console.log(`验收记录：${join(output, 'report.json')}`);
