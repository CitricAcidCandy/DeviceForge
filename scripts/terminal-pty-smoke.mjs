import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { powershellArguments, prepareHost, reservePort } from './terminal-pty-smoke/host.mjs';
import { fileIdentity } from './unified-discovery-smoke/evidence.mjs';
import { malformedCase, pipeCase, powershellCase, treeCase, ttyCase } from './terminal-pty-smoke/cases.mjs';
import { windowsObservation } from './terminal-pty-smoke/windows.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
assert.ok(args.length <= 3, '参数为宿主绝对路径、插件绝对路径、可选报告目录');
assert.equal(process.platform, 'win32', '本轮验收只针对Windows ConPTY');
const sourceHost = args[0] ?? join(root, 'backend/target/debug/apk-server.exe');
const sourcePlugin = args[1] ?? join(root, 'backend/target/debug/deviceforge-terminal-plugin.exe');
assert.ok(isAbsolute(sourceHost) && isAbsolute(sourcePlugin), '受检二进制路径须为绝对路径');
const directory = resolve(args[2] ?? join(root, 'artifacts/terminal-pty-20261022', randomUUID()));
const snapshot = join(directory, 'snapshot');
const report = {
  timestamp: new Date().toISOString(), directory, passed: false,
  scope: 'Windows真实Rust宿主/插件HTTP、Node原生TTY、PowerShell及派生树；不操作设备、不发模型任务；浏览器与Codex另行验收',
  checks: [], sessions: [], requests: [], observations: [],
};
await mkdir(snapshot, { recursive: true });
let host;
try {
  const sources = [sourceHost, sourcePlugin, join(root, 'backend/plugins/terminal/manifest.json'), join(root, 'scripts/terminal-pty-smoke/fixture.cjs')];
  const names = ['apk-server.exe', 'deviceforge-terminal-plugin.exe', 'manifest.json', 'fixture.cjs'];
  report.inputs_before = await Promise.all(sources.map(fileIdentity));
  for (let index = 0; index < sources.length; index++) {
    await copyFile(sources[index], join(snapshot, names[index]));
    assert.equal((await fileIdentity(join(snapshot, names[index]))).sha256, report.inputs_before[index].sha256);
  }
  host = await prepareHost({ root, binary: join(snapshot, names[0]), directory: join(directory, 'data'), report, port: await reservePort() });
  await host.ready();
  report.base = host.client.base;
  const plugin = join(host.plugins, 'terminal');
  await mkdir(plugin);
  const treeIdentity = join(directory, 'tree.json');
  const manifest = JSON.parse(await readFile(join(snapshot, 'manifest.json'), 'utf8'));
  const profiles = {
    powershell: {
      executable: 'powershell.exe',
      args: powershellArguments(directory),
      resource_scope: 'direct_process',
    },
    probe: { executable: process.execPath, args: [join(snapshot, 'fixture.cjs'), 'probe'], resource_scope: 'direct_process' },
    branch: { executable: process.execPath, args: [join(snapshot, 'fixture.cjs'), 'branch', treeIdentity], resource_scope: 'direct_process' },
  };
  const config = join(plugin, 'terminal.config.json');
  await writeFile(config, JSON.stringify({ format_version: 1, profiles }), { flag: 'wx' });
  manifest.executable = join(snapshot, 'deviceforge-terminal-plugin.exe');
  manifest.args = ['--config', config];
  manifest.configuration.defaults = { format_version: 1, profiles };
  await writeFile(join(plugin, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx' });
  await host.client.post('/api/v2/plugins/terminal/load');
  report.initial_windows = await windowsObservation(host.child.pid);
  await ttyCase(host, report);
  await powershellCase(host, report);
  await pipeCase(host, report);
  await malformedCase(host, report);
  await treeCase(host, report, treeIdentity, 'cancel');
  await treeCase(host, report, treeIdentity, 'eof');
  await treeCase(host, report, treeIdentity, 'unload');
  await host.client.post('/api/v2/plugins/terminal/load');
  await treeCase(host, report, treeIdentity, 'shutdown');
  await host.verifyIdentity();
  report.inputs_after = await Promise.all(sources.map(fileIdentity));
  assert.deepEqual(report.inputs_after, report.inputs_before, '验收期间输入文件不得改变');
  report.log_ids = [...host.client.logIds];
  report.passed = true;
} catch (error) {
  report.failure = { name: error.name, message: error.message, stack: String(error.stack).split('\n').slice(0, 7) };
} finally {
  if (host) {
    try { await host.finish(); }
    catch (error) { report.cleanup_failure = { name: error.name, message: error.message }; report.passed = false; }
  }
  report.completed_at = new Date().toISOString();
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ directory, passed: report.passed, checks: report.checks.length, failure: report.failure }));
  if (!report.passed) process.exitCode = 1;
}
