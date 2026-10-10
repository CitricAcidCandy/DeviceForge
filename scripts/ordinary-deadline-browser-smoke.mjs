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
import { createBrowserFixture } from './ordinary-deadline-browser/fixtures.mjs';
import { loadServerFixtures, createDefaultEvidence, preserveControls } from './ordinary-deadline-browser/package-client.mjs';
import { createBridge } from './ordinary-deadline-browser/bridge.mjs';
import { tree, manifest, createHostClient } from './ordinary-deadline-browser/report.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
assert.ok(process.argv.slice(2).every((value) => value === '--release'), '仅支持--release');
const profile = process.argv.includes('--release') ? 'release' : 'debug';
const binary = resolve(root, 'backend/target', profile, process.platform === 'win32' ? 'apk-server.exe' : 'apk-server');
const dist = resolve(root, 'frontend/dist');
await mkdir(resolve(root, 'artifacts'), { recursive: true });
const artifacts = await mkdtemp(join(root, 'artifacts', 'ordinary-deadline-browser-' + profile + '-'));
const reportPath = join(artifacts, 'report.json');
const report = { run_id: randomUUID(), started_at: new Date().toISOString(), profile, platform: process.platform, passed: false,
  packages: [], backend_process: {}, browser_process: {}, stage: '创建本次临时根',
  scope: '真实production宿主、在线SDK插件消费普通预算、有限default任务与历史、两端热装卸；无产品UI',
  boundary: { over61SecondsVerified: false, longSubmitted: false, shortHoldSubmitted: false,
    cleanMarkerProvesExternalResources: false, realDevice: false, npxVerified: false } };
let temporary; let bridge; let observer; let child; let host; let inputs; let fixtures;
async function reservePort() {
  const server = createServer();
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const port = server.address().port;
  await new Promise((done, reject) => server.close((error) => error ? reject(error) : done()));
  return port;
}
async function inputPaths() {
  return [...new Set([
    fileURLToPath(import.meta.url), binary,
    ...await tree(resolve(root, 'scripts/ordinary-deadline-browser')),
    ...await tree(resolve(root, 'scripts/ordinary-deadline')),
    resolve(root, 'scripts/unified-discovery-browser/browser-driver.mjs'),
    resolve(root, 'scripts/unified-discovery-browser/lifecycle.mjs'),
    resolve(root, 'backend/scripts/online-plugins/fixtures.mjs'),
    resolve(root, 'scripts/device-provider/fixtures.mjs'),
    resolve(root, 'scripts/device-provider/client.mjs'),
    resolve(root, 'backend/docs/普通操作总期限第一批契约.md'),
    resolve(root, 'frontend/docs/普通操作总期限消费契约.md'),
    ...await tree(dist, ['.js', '.css', '.html', '.json']),
  ])].sort();
}
try {
  temporary = await mkdtemp(join(tmpdir(), 'deviceforge-ordinary-browser-'));
  report.temporary_root = temporary;
  report.stage = '冻结实际执行输入';
  inputs = await inputPaths(); report.inputs_before = await manifest(root, inputs);
  report.node_runtime = { path: process.execPath, version: process.version, ...await digest(process.execPath) };
  report.backend_host = { path: relative(root, binary), ...await digest(binary) };
  report.production_host = { path: 'frontend/dist/assets/plugin-host.js', ...await digest(join(dist, 'assets/plugin-host.js')) };
  const contract = await digest(resolve(root, 'backend/docs/普通操作总期限第一批契约.md'));
  assert.equal(contract.sha256.toUpperCase(), '6CBE0F61F84D52617AE6939C3FE630303251F44CC37D9777733D8A0336A40914');
  report.contract = contract;
  report.stage = '读取Galileo冻结夹具';
  fixtures = await loadServerFixtures(join(temporary, 'fixtures'), artifacts, report);
  const browserFixture = await createBrowserFixture(fixtures);
  const browserArchive = join(artifacts, 'browser.tgz'); await writeFile(browserArchive, browserFixture.archive);
  report.packages.push({ kind: 'browser', pluginId: browserFixture.id, archive: browserArchive,
    ...await digest(browserArchive), generator: 'scripts/ordinary-deadline-browser/fixtures.mjs::createBrowserFixture',
    files: browserFixture.files.map((file) => ({ path: file.path, bytes: Buffer.byteLength(file.bytes) })) });
  report.stage = '启动本次真实Rust宿主';
  const port = await reservePort(); const base = 'http://127.0.0.1:' + port;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(APK_|DEVICEFORGE_)/i.test(name)));
  Object.assign(env, { APK_BIND: '127.0.0.1:' + port, APK_DATA_DIR: join(temporary, 'data'),
    APK_PLUGIN_DIR: join(temporary, 'server-plugins'), APK_BROWSER_PLUGIN_DIR: join(temporary, 'browser-plugins'),
    DEVICEFORGE_NODE: process.execPath, DEVICEFORGE_HTTP_RATE: '10000' });
  report.backend_process.command = { executable: binary, args: [], environmentNames: [
    'APK_BIND', 'APK_DATA_DIR', 'APK_PLUGIN_DIR', 'APK_BROWSER_PLUGIN_DIR', 'DEVICEFORGE_NODE', 'DEVICEFORGE_HTTP_RATE'] };
  child = spawn(binary, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
  observer = observeChild(child, report.backend_process);
  host = createHostClient(base, report); await host.ready(report.backend_process);
  bridge = await createBridge({ base, dist, fixtures, browserFixture, report,
    verifyDefault: createDefaultEvidence(fixtures, artifacts, report) });
  report.stage = '真实生产浏览器消费';
  report.browser = await runBrowser({ pageUrl: bridge.origin + '/__verification',
    expression: '(async () => (await import("/__harness.mjs")).verifyOrdinaryDeadline())()',
    profileDirectory: join(temporary, 'browser-profile'), evidence: report.browser_process,
    observeResult: (result) => { report.browser = result; } });
  assert.equal(report.browser?.passed, true, '浏览器验收失败，详见逐项证据');
  assert.equal(report.bridge.errors.length, 0, '本次代理异常');
  assert.equal(report.default_processes.length, 2);
  assert.ok(report.default_processes.every((entry) => entry.passed && entry.pidAbsent));
  const submissions = report.bridge.requests.filter((entry) => entry.method === 'POST' && entry.path === '/api/v2/jobs');
  assert.equal(submissions.length, 2, '浏览器只能提交两项有限default');
  assert.ok(submissions.every((entry) => fixtures.some((fixture) => fixture.operations.default === entry.operation
    && fixture.caseId === entry.caseId)));
  report.stage = '关闭本次代理和Rust宿主';
  await bridge.close(); bridge = undefined;
  await host.call('/api/v2/system/shutdown', { method: 'POST' }); await observer.wait(10000);
  assert.equal(normalExit(report.backend_process), true, '真实Rust宿主未正常OS退出');
  report.passed = true;
} catch (error) { report.error = String(error.message).slice(0, 1200); }
finally {
  if (bridge) {
    try { await bridge.close(); }
    catch (error) { report.bridge_cleanup_error = String(error.message).slice(0, 500); report.passed = false; }
  }
  if (observer && !report.backend_process.close) {
    try {
      if (!report.backend_process.exit && !report.backend_process.spawn_error) {
        await host.call('/api/v2/system/shutdown', { method: 'POST' });
      }
      await observer.wait(10000);
    } catch {
      try { await observer.force(); }
      catch (error) { report.backend_cleanup_error = String(error.message).slice(0, 500); }
    }
  }
  if (observer) report.backend_process.normal_exit = normalExit(report.backend_process);
  if (fixtures) {
    try { await preserveControls(fixtures, artifacts, report); }
    catch (error) { report.control_evidence_error = String(error.message).slice(0, 600); report.passed = false; }
  }
  if (!report.backend_process.normal_exit || !report.browser_process.normal_exit) report.passed = false;
  if (inputs) {
    try {
      report.inputs_after = await manifest(root, await inputPaths());
      report.inputs_stable = JSON.stringify(report.inputs_before) === JSON.stringify(report.inputs_after);
      if (!report.inputs_stable) report.passed = false;
    } catch (error) { report.input_check_error = String(error.message).slice(0, 600); report.passed = false; }
  }
  if (temporary) {
    const within = relative(tmpdir(), temporary);
    if (!within || isAbsolute(within) || within === '..' || within.startsWith('..' + '/') || within.startsWith('..' + '\\')
      || !within.startsWith('deviceforge-ordinary-browser-')) {
      report.cleanup_error = '本次临时根边界检查失败'; report.passed = false;
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
