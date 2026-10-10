import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBrowser } from './unified-discovery-browser/browser-driver.mjs';
import { digest, observeChild, normalExit } from './unified-discovery-browser/lifecycle.mjs';
import { tree, manifest, createHostClient } from './ordinary-deadline-browser/report.mjs';
import { createFixtures } from './browser-task-history-smoke/fixtures.mjs';
import { createBridge } from './browser-task-history-smoke/bridge.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
assert.ok(process.argv.slice(2).every((value) => value === '--release'), '仅支持--release');
const profile = process.argv.includes('--release') ? 'release' : 'debug';
const binary = resolve(root, 'backend/target', profile, process.platform === 'win32' ? 'apk-server.exe' : 'apk-server');
const dist = resolve(root, 'frontend/dist');
await mkdir(resolve(root, 'artifacts'), { recursive: true });
const artifacts = await mkdtemp(join(root, 'artifacts', 'browser-task-history-' + profile + '-'));
const reportPath = join(artifacts, 'report.json');
const report = { run_id: randomUUID(), started_at: new Date().toISOString(), profile, platform: process.platform,
  passed: false, stage: '冻结执行输入', packages: [], backend_process: {}, browser_process: {},
  scope: '真实production宿主与在线插件、HTTP任务历史及事件、取消晚到和代次撤销；无产品UI',
  boundary: { longProcessDeadlineVerified: false, realDevice: false, npxVerified: false,
    lanVerified: false, serverRestartHistoryVerified: false, externalPluginResourcesVerified: false } };
let temporary; let bridge; let observer; let host; let inputs;

async function reservePort() {
  const server = createServer();
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const port = server.address().port;
  await new Promise((done, reject) => server.close((error) => error ? reject(error) : done())); return port;
}
async function inputPaths() {
  return [...new Set([
    fileURLToPath(import.meta.url), binary, process.execPath,
    ...await tree(resolve(root, 'scripts/browser-task-history-smoke')),
    resolve(root, 'scripts/unified-discovery-browser/browser-driver.mjs'),
    resolve(root, 'scripts/unified-discovery-browser/lifecycle.mjs'),
    resolve(root, 'scripts/ordinary-deadline-browser/report.mjs'),
    resolve(root, 'backend/scripts/online-plugins/fixtures.mjs'),
    resolve(root, 'frontend/docs/任务历史与事件公开接口第一批裁定.md'),
    resolve(root, 'frontend/docs/任务历史与事件插件接入示例.md'),
    resolve(root, 'frontend/src/plugin-sdk/task-history.ts'),
    resolve(root, 'frontend/src/app/task-history-gateway.ts'),
    resolve(root, 'frontend/src/plugins/task-history-access.ts'),
    ...await tree(dist, ['.js', '.css', '.html', '.json']),
  ])].sort();
}

try {
  temporary = await mkdtemp(join(tmpdir(), 'deviceforge-task-history-browser-'));
  report.temporary_root = temporary; inputs = await inputPaths(); report.inputs_before = await manifest(root, inputs);
  report.node_runtime = { path: process.execPath, version: process.version, ...await digest(process.execPath) };
  report.backend_host = { path: relative(root, binary), ...await digest(binary) };
  report.production_host = { path: 'frontend/dist/assets/plugin-host.js', ...await digest(join(dist, 'assets/plugin-host.js')) };
  report.stage = '生成本次有限真实夹具';
  const fixtures = await createFixtures(); fixtures.config.runId = report.run_id;
  for (const kind of ['server', 'browser']) {
    const fixture = fixtures[kind]; const archive = join(artifacts, kind + '.tgz'); await writeFile(archive, fixture.archive);
    report.packages.push({ kind, id: fixture.id, archive, ...await digest(archive),
      generator: kind === 'server' ? 'backend/scripts/online-plugins/fixtures.mjs::serverFixture(2)'
        : 'scripts/browser-task-history-smoke/fixtures.mjs::createFixtures',
      files: fixture.files.map((file) => ({ path: file.path, bytes: Buffer.byteLength(file.bytes) })) });
  }
  report.stage = '启动本次独立Rust宿主';
  const port = await reservePort(); const base = 'http://127.0.0.1:' + port;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(APK_|DEVICEFORGE_)/i.test(name)));
  Object.assign(env, { APK_BIND: '127.0.0.1:' + port, APK_DATA_DIR: join(temporary, 'data'),
    APK_PLUGIN_DIR: join(temporary, 'server-plugins'), APK_BROWSER_PLUGIN_DIR: join(temporary, 'browser-plugins'),
    DEVICEFORGE_NODE: process.execPath, DEVICEFORGE_HTTP_RATE: '10000' });
  report.backend_process.command = { executable: binary, args: [], environmentNames: [
    'APK_BIND', 'APK_DATA_DIR', 'APK_PLUGIN_DIR', 'APK_BROWSER_PLUGIN_DIR', 'DEVICEFORGE_NODE', 'DEVICEFORGE_HTTP_RATE'] };
  const child = spawn(binary, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
  observer = observeChild(child, report.backend_process);
  host = createHostClient(base, report); await host.ready(report.backend_process);
  bridge = await createBridge({ base, dist, fixtures, report });
  report.serve_identity = { origin: bridge.origin, api_upstream: base, dist: relative(root, dist),
    production_entry: '/assets/plugin-host.js', backend_pid: report.backend_process.pid };
  report.stage = '真实生产浏览器任务历史消费';
  report.browser = await runBrowser({ pageUrl: bridge.origin + '/__verification',
    expression: '(async () => (await import("/__modules/harness.mjs")).verifyTaskHistory())()',
    profileDirectory: join(temporary, 'browser-profile'), evidence: report.browser_process,
    observeResult: (result) => { report.browser = result; } });
  assert.equal(report.browser?.passed, true, '任务历史浏览器功能失败，详见逐项证据');
  assert.equal(report.browser.runId, report.run_id, '浏览器报告不属于本次夹具');
  assert.equal(report.bridge.errors.length, 0, '本次透明代理存在错误');
  assert.equal(report.bridge.gates.length, 7, '取消门闩场景不完整');
  assert.ok(report.bridge.gates.every((gate) => gate.delivered && !gate.timedOut && !gate.disconnected), '门闩回执未正常交付');
  // 浏览器日志必须能追溯到同一代理的真实服务器响应，而非本地生成。
  for (const entry of report.browser.transport.filter((entry) => entry.logId)) {
    assert.ok(report.bridge.requests.some((actual) => actual.path === entry.path && actual.status === entry.status
      && actual.logId === entry.logId), '公开SDK日志不属于本次真实宿主');
  }
  assert.ok(!report.bridge.requests.some((entry) => entry.path.endsWith('/cancel')), '历史查询撤销不应取消服务器Job');
  report.stage = '关闭本次代理和Rust宿主';
  await bridge.close(); bridge = undefined;
  await host.call('/api/v2/system/shutdown', { method: 'POST' }); await observer.wait(10000);
  assert.equal(normalExit(report.backend_process), true, 'Rust宿主没有正常OS终态'); report.passed = true;
} catch (error) { report.error = String(error.message).slice(0, 1400); }
finally {
  if (bridge) {
    try { await bridge.close(); }
    catch (error) { report.bridge_cleanup_error = String(error.message).slice(0, 600); report.passed = false; }
  }
  if (observer && !report.backend_process.close) {
    try {
      if (!report.backend_process.exit && !report.backend_process.spawn_error) await host.call('/api/v2/system/shutdown', { method: 'POST' });
      await observer.wait(10000);
    } catch {
      try { await observer.force(); }
      catch (error) { report.backend_cleanup_error = String(error.message).slice(0, 600); }
    }
  }
  if (observer) report.backend_process.normal_exit = normalExit(report.backend_process);
  if (!report.backend_process.normal_exit || !report.browser_process.normal_exit) report.passed = false;
  if (report.browser_process.executable_path) {
    try {
      report.browser_process.binary_after = await digest(report.browser_process.executable_path);
      report.browser_process.binary_stable = JSON.stringify(report.browser_process.binary) === JSON.stringify(report.browser_process.binary_after);
      if (!report.browser_process.binary_stable) report.passed = false;
    } catch (error) { report.browser_binary_error = String(error.message).slice(0, 600); report.passed = false; }
  }
  if (inputs) {
    try {
      report.inputs_after = await manifest(root, await inputPaths());
      report.inputs_stable = JSON.stringify(report.inputs_before) === JSON.stringify(report.inputs_after);
      if (!report.inputs_stable) report.passed = false;
    } catch (error) { report.input_check_error = String(error.message).slice(0, 600); report.passed = false; }
  }
  if (temporary) {
    const within = relative(tmpdir(), resolve(temporary));
    if (!within || isAbsolute(within) || within === '..' || within.startsWith('../') || within.startsWith('..\\')
      || !within.startsWith('deviceforge-task-history-browser-')) {
      report.cleanup_error = '本次临时根边界核对失败'; report.passed = false;
    } else if (report.passed) {
      try { await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
      catch (error) { report.cleanup_error = error.code; report.passed = false; }
    }
    if (!report.passed) report.temporary_retained = temporary;
  }
  if (!report.passed) process.exitCode = 1;
  report.finished_at = new Date().toISOString();
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
}
console.log(JSON.stringify({ passed: report.passed, report: reportPath, error: report.error }));
