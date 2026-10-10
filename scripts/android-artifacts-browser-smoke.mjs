import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, lstat, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve, join, relative, isAbsolute, toNamespacedPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBrowser } from './unified-discovery-browser/browser-driver.mjs';
import { digest, observeChild, normalExit } from './unified-discovery-browser/lifecycle.mjs';
import { tree, manifest, createHostClient } from './ordinary-deadline-browser/report.mjs';
import { createFixtures } from './android-artifacts-browser-smoke/fixtures.mjs';
import { createBridge } from './android-artifacts-browser-smoke/bridge.mjs';
import { prepareDeployment, verifyDeployment } from './android-artifacts-browser-smoke/deployment.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
let profile = 'debug', toolBinary, sourceDirectory;
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--release') { assert.equal(profile, 'debug', '--release不可重复'); profile = 'release'; }
  else if (args[index] === '--tool-binary') { assert.equal(toolBinary, undefined); toolBinary = args[++index]; assert.ok(toolBinary && isAbsolute(toolBinary), '--tool-binary须绝对路径'); }
  else if (args[index] === '--source-directory') { assert.equal(sourceDirectory, undefined); sourceDirectory = args[++index]; assert.ok(sourceDirectory && isAbsolute(sourceDirectory), '--source-directory须绝对路径'); }
  else assert.fail('仅支持--release、--tool-binary、--source-directory');
}
assert.ok(toolBinary, '须显式传入已编译的device_artifacts/fixtures/device-tool.rs二进制');
const suffix = process.platform === 'win32' ? '.exe' : '';
const binary = join(root, 'backend/target', profile, 'apk-server' + suffix);
const source = sourceDirectory ?? join(root, 'backend/plugins/android-device');
const dist = join(root, 'frontend/dist');
await mkdir(join(root, 'artifacts'), { recursive: true });
const artifacts = await mkdtemp(join(root, 'artifacts', 'android-artifacts-browser-' + profile + '-'));
const reportPath = join(artifacts, 'report.json');
const report = { run_id: randomUUID(), started_at: new Date().toISOString(), profile, passed: false,
  stage: '冻结输入', scope: '生产浏览器公开SDK、真实native安卓安装/截图与HTTP/MCP同历史；受控独立工具，不含产品UI',
  backend_process: {}, browser_process: {}, boundary: { realDevice: false, realAdbDaemon: false,
    installableApk: false, productUI: false, lan: false, npx: false, inFlightToolCancellation: false,
    derivedProcessTree: false, performance: false } };
let temporary, bridge, observer, host, deployment, inputs, port;

async function reservePort() {
  const server = createServer(); await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const value = server.address().port; await new Promise((done, reject) => server.close((error) => error ? reject(error) : done())); return value;
}
async function verifyPort() {
  const server = createServer(); const evidence = { host: '127.0.0.1', port, verified: false }; report.backend_process.port_release = evidence;
  try { await new Promise((done, reject) => { server.once('error', reject); server.listen(port, evidence.host, done); }); evidence.verified = true; }
  finally { if (server.listening) await new Promise((done, reject) => server.close((error) => error ? reject(error) : done())); }
}
async function inputPaths() {
  return [...new Set([fileURLToPath(import.meta.url), binary, process.execPath, toolBinary,
    join(root, 'backend/target', profile, 'deviceforge-android-device-plugin' + suffix),
    ...await tree(join(root, 'scripts/android-artifacts-browser-smoke')),
    ...await tree(dist, ['.js', '.css', '.html', '.json']),
    ...['package.json', 'manifest.json', 'README.md'].map((name) => join(source, name)),
    ...['scripts/unified-discovery-browser/browser-driver.mjs', 'scripts/unified-discovery-browser/lifecycle.mjs',
      'scripts/ordinary-deadline-browser/report.mjs', 'scripts/android-packages-smoke/samples.mjs',
      'backend/scripts/online-plugins/fixtures.mjs', 'cli/src/plugin-package.mjs', 'cli/src/paths.mjs',
      'frontend/src/plugin-sdk/devices.ts', 'frontend/src/plugin-sdk/artifacts.ts', 'frontend/src/plugin-sdk/models.ts',
      'frontend/src/plugins/contracts.ts', 'frontend/src/plugins/contributions.ts',
      'frontend/docs/安卓安装截图产物消费接缝.md', 'backend/docs/安卓安装截图插件实施裁定.md',
      'backend/crates/infrastructure/src/device_artifacts/fixtures/device-tool.rs',
      'backend/crates/infrastructure/src/device_input/fixtures/shell_words.rs',
      'backend/crates/infrastructure/src/performance/fixtures/probe.rs',
      'backend/crates/infrastructure/src/device_artifacts/fixtures/pixel.png'].map((name) => join(root, name))])].sort();
}

try {
  temporary = await mkdtemp(join(tmpdir(), 'deviceforge-android-artifacts-browser-')); report.temporary_root = temporary;
  inputs = await inputPaths(); report.inputs_before = await manifest(root, inputs);
  report.node_runtime = { version: process.version, path: process.execPath, ...await digest(process.execPath) };
  report.backend_host = { path: relative(root, binary), ...await digest(binary) };
  report.production_host = { path: 'frontend/dist/assets/plugin-host.js', ...await digest(join(dist, 'assets/plugin-host.js')) };
  const fixtures = await createFixtures(); await writeFile(join(artifacts, 'browser.tgz'), fixtures.browser.archive);
  report.fixtures = { apk: { bytes: fixtures.apk.length, sha256: fixtures.apkSha256 }, png: { bytes: fixtures.pixel.length, sha256: fixtures.pixelSha256 }, browser_archive: await digest(join(artifacts, 'browser.tgz')) };
  port = await reservePort(); const base = 'http://127.0.0.1:' + port;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(APK_|DEVICEFORGE_)/i.test(name)));
  Object.assign(env, { APK_BIND: '127.0.0.1:' + port, APK_DATA_DIR: join(temporary, 'data'),
    APK_PLUGIN_DIR: join(temporary, 'data/server-plugins'), APK_BROWSER_PLUGIN_DIR: join(temporary, 'data/browser-plugins'),
    APK_MCP_HOSTS: '127.0.0.1:' + port, APK_MCP_ORIGINS: base,
    DEVICEFORGE_NODE: process.execPath, DEVICEFORGE_HTTP_RATE: '10000' });
  report.stage = '启动空目录真实Rust宿主';
  observer = observeChild(spawn(binary, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env }), report.backend_process);
  host = createHostClient(base, report); await host.ready(report.backend_process);
  const empty = await host.call('/api/v2/device-providers'); assert.deepEqual(empty, []);
  const emptyOperations = await host.call('/api/v2/operations');
  assert.ok(!emptyOperations.some((item) => item.id.startsWith('plugin.android-device.') || ['android.app.install', 'android.screenshot'].includes(item.id)), '无插件仍有安装/截图内置回退');
  report.empty_catalog = { providers: empty, androidInstallScreenshotAbsent: true };
  report.stage = '部署实际native包并公开load';
  deployment = await prepareDeployment({ root, directory: temporary, profile, toolBinary, source, report });
  const loaded = await host.call('/api/v2/plugins/android-device/load', { method: 'POST' }); assert.equal(loaded.id, 'android-device');
  bridge = await createBridge({ base, dist, fixtures, report });
  report.stage = '生产浏览器安装截图消费';
  report.browser = await runBrowser({ pageUrl: bridge.origin + '/__verification',
    expression: '(async () => (await import("/__modules/harness.mjs")).verifyAndroidArtifacts())()',
    profileDirectory: join(temporary, 'browser-profile'), evidence: report.browser_process,
    observeResult: (value) => { report.browser = value; } });
  assert.equal(report.browser?.passed, true, '浏览器安装截图场景失败，详见逐项报告');
  assert.equal(report.browser.runId, report.run_id, '浏览器报告不属于本次夹具');
  assert.equal(report.browser.steps.length, 9); assert.equal(report.bridge.errors.length, 0);
  for (const entry of report.browser.transport.filter((entry) => entry.logId)) assert.ok(report.bridge.requests.some((actual) => actual.path === entry.path && actual.status === entry.status && actual.logId === entry.logId), 'SDK日志不属于本次真实宿主');
  for (const entry of report.browser.mcp ?? []) assert.ok(report.bridge.requests.some((actual) => actual.path === '/mcp' && actual.status === entry.status && actual.logId === entry.logId), 'MCP日志不属于本次真实宿主');
  await verifyDeployment(deployment, report);
  const marker = join(deployment.published, 'portable/bin/installation-path'); const privatePath = await readFile(marker, 'utf8');
  const within = relative(toNamespacedPath(join(temporary, 'scratch')), toNamespacedPath(privatePath));
  assert.ok(within && !isAbsolute(within) && !within.startsWith('..'), '工具未消费自有scratch安装副本');
  await assert.rejects(lstat(privatePath), { code: 'ENOENT' });
  assert.deepEqual(await readdir(join(temporary, 'scratch')), [], '插件私有scratch目录未清空');
  report.resource_cleanup = { private_installation_copy_removed: true, scratch_empty: true, marker_private_path_retained: false };
  report.stage = '关闭本次代理与宿主'; await bridge.close(); bridge = undefined;
  await host.call('/api/v2/system/shutdown', { method: 'POST' }); await observer.wait(10000);
  assert.equal(normalExit(report.backend_process), true); await verifyPort(); report.passed = true;
} catch (error) { report.error = String(error.message).slice(0, 1200); }
finally {
  if (bridge) { try { await bridge.close(); } catch (error) { report.bridge_cleanup_error = error.code ?? 'bridge_close_failed'; report.passed = false; } }
  if (observer && !report.backend_process.close) {
    try {
      if (!report.backend_process.exit && !report.backend_process.spawn_error) await host.call('/api/v2/system/shutdown', { method: 'POST' });
      await observer.wait(10000);
    } catch { try { await observer.force(); } catch (error) { report.backend_cleanup_error = error.code ?? 'backend_close_failed'; } }
  }
  if (observer) report.backend_process.normal_exit = normalExit(report.backend_process);
  if (!report.backend_process.normal_exit || !report.browser_process.normal_exit) report.passed = false;
  if (port && report.backend_process.normal_exit && !report.backend_process.port_release?.verified) {
    try { await verifyPort(); } catch (error) { report.port_release_error = error.code ?? 'bind_failed'; report.passed = false; }
  }
  if (report.browser_process.executable_path) {
    try {
      report.browser_process.binary_after = await digest(report.browser_process.executable_path);
      report.browser_process.binary_stable = JSON.stringify(report.browser_process.binary) === JSON.stringify(report.browser_process.binary_after);
      if (!report.browser_process.binary_stable) report.passed = false;
    } catch (error) { report.browser_binary_error = error.code ?? 'binary_read_failed'; report.passed = false; }
  }
  if (inputs) {
    try {
      report.inputs_after = await manifest(root, await inputPaths());
      report.inputs_stable = JSON.stringify(report.inputs_before) === JSON.stringify(report.inputs_after);
      if (!report.inputs_stable) report.passed = false;
    } catch (error) { report.input_check_error = error.code ?? 'manifest_failed'; report.passed = false; }
  }
  if (temporary) {
    const within = relative(tmpdir(), resolve(temporary));
    if (!within || isAbsolute(within) || within.startsWith('..') || !within.startsWith('deviceforge-android-artifacts-browser-')) {
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
console.log(JSON.stringify({ passed: report.passed, report: reportPath, stage: report.stage, error: report.error }));
