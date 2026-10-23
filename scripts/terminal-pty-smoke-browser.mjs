import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { powershellArguments, prepareHost, reservePort } from './terminal-pty-smoke/host.mjs';
import { fileIdentity } from './unified-discovery-smoke/evidence.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const [sourceHost, sourcePlugin, productionWeb, outputArgument] = process.argv.slice(2);
assert.equal(process.platform, 'win32', '只验收Windows ConPTY');
assert.ok(sourceHost && sourcePlugin && productionWeb, '参数为冻结宿主、冻结插件、生产构建目录、可选报告目录');
assert.ok([sourceHost, sourcePlugin, productionWeb].every(isAbsolute), '受检输入须为绝对路径');
const directory = resolve(outputArgument ?? join(root, 'artifacts/terminal-pty-20261022', 'browser-' + randomUUID()));
const snapshot = join(directory, 'snapshot');
const report = { started_at: new Date().toISOString(), directory, passed: false, requests: [],
  scope: '独占冻结宿主与插件、真实生产前端、真实Edge/xterm/PowerShell/Codex；不操作7031、设备、模型prompt或登录' };
await mkdir(snapshot, { recursive: true });
let host, child;
try {
  const sources = [sourceHost, sourcePlugin, join(root, 'backend/plugins/terminal/manifest.json'), join(productionWeb, 'index.html')];
  report.inputs_before = await Promise.all(sources.map(fileIdentity));
  await copyFile(sourceHost, join(snapshot, 'apk-server.exe'));
  await copyFile(sourcePlugin, join(snapshot, 'deviceforge-terminal-plugin.exe'));
  const sourcesCopied = await Promise.all(['apk-server.exe', 'deviceforge-terminal-plugin.exe'].map((name) => fileIdentity(join(snapshot, name))));
  sourcesCopied.forEach((value, index) => assert.equal(value.sha256, report.inputs_before[index].sha256));
  host = await prepareHost({ root, binary: join(snapshot, 'apk-server.exe'), directory: join(directory, 'data'), report, port: await reservePort() });
  await host.ready();
  report.base = host.client.base;
  const plugin = join(host.plugins, 'terminal'), work = join(directory, 'workspace');
  await mkdir(plugin); await mkdir(work);
  const profiles = { powershell: { executable: 'powershell.exe', directory: work,
    args: powershellArguments(directory), resource_scope: 'direct_process' } };
  report.powershell_history = '测试启动参数指定本次报告目录，SaveNothing且禁用预测；不修改用户全局配置。';
  const config = join(plugin, 'terminal.config.json');
  await writeFile(config, JSON.stringify({ format_version: 1, profiles }), { flag: 'wx' });
  const manifest = JSON.parse(await readFile(join(root, 'backend/plugins/terminal/manifest.json'), 'utf8'));
  manifest.executable = join(snapshot, 'deviceforge-terminal-plugin.exe');
  manifest.args = ['--config', config];
  manifest.configuration.defaults = { format_version: 1, profiles };
  await writeFile(join(plugin, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx' });
  await host.client.post('/api/v2/plugins/terminal/load');
  const browserDirectory = join(directory, 'browser');
  child = spawn(process.execPath, [join(root, 'frontend/scripts/terminal-pty-browser-probe.ts'), productionWeb,
    host.client.base, browserDirectory, String(host.child.pid), host.directory], { cwd: join(root, 'frontend'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  report.probe_pid = child.pid;
  let stdout = '', stderr = '';
  child.stdout.on('data', (bytes) => { stdout = (stdout + bytes.toString()).slice(-16384); });
  child.stderr.on('data', (bytes) => { stderr = (stderr + bytes.toString()).slice(-16384); });
  const exited = await Promise.race([
    new Promise((done, fail) => { child.once('error', fail); child.once('close', (code, signal) => done({ code, signal })); }),
    delay(210000, undefined, { ref: false }).then(() => ({ timeout: true })),
  ]);
  report.probe_exit = exited;
  report.probe_stdout = stdout; report.probe_stderr = stderr;
  assert.equal(exited.timeout, undefined, '浏览器验收不得超出210秒（含正常关闭等待）');
  assert.deepEqual(exited, { code: 0, signal: null });
  const browserReport = JSON.parse(await readFile(join(browserDirectory, 'browser-report.json'), 'utf8'));
  assert.equal(browserReport.passed, true);
  report.browser_report = join(browserDirectory, 'browser-report.json');
  await host.shutdown();
  await host.verifyIdentity();
  report.inputs_after = await Promise.all(sources.map(fileIdentity));
  assert.deepEqual(report.inputs_after, report.inputs_before, '冻结输入验收期间不可改变');
  report.log_ids = [...host.client.logIds];
  report.passed = true;
} catch (error) {
  report.failure = { name: error.name, message: error.message, stack: String(error.stack).split('\n').slice(0, 7) };
} finally {
  if (child && child.exitCode === null) {
    // 只终止本次仍持有句柄的探针树，避免超时探针遗留独占Edge子进程。
    await promisify(execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }).catch((error) => { report.probe_tree_cleanup_failure = error.message; });
    report.forced_probe_exit = true; report.passed = false;
    await Promise.race([new Promise((done) => child.once('close', done)), delay(5000)]);
  }
  if (host) {
    try { await host.finish(); }
    catch (error) { report.cleanup_failure = { name: error.name, message: error.message }; report.passed = false; }
  }
  report.completed_at = new Date().toISOString();
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ directory, passed: report.passed, failure: report.failure }));
  if (!report.passed) process.exitCode = 1;
}
