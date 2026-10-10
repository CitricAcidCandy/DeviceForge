import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { networkConfig } from '../../../cli/src/network.mjs';
import { runBrowser } from '../../../scripts/unified-discovery-browser/browser-driver.mjs';
import { digest, observeChild, normalExit } from '../../../scripts/unified-discovery-browser/lifecycle.mjs';
import { exited } from '../../../scripts/unified-discovery/fixtures.mjs';
import { createFixtures, preserveProvider, providerControl, verifyFrozenInputs } from './fixtures.mjs';
import { createBridge } from './bridge.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const options = { release: false,
  archive: 'artifacts/browser-example-20261010-004118/deviceforge-browser-device-tools-example-0.1.0.tgz',
  archiveSha256: '79DE721D199B1BA71923EF8FEA6AAF93F162A5C5F0145905B186DD604ABF7726' };
const argumentsList = process.argv.slice(2); const seen = new Set();
for (let index = 0; index < argumentsList.length; ++index) {
  const name = argumentsList[index]; assert.ok(!seen.has(name), '参数不能重复：' + name); seen.add(name);
  if (name === '--release') { options.release = true; continue; }
  const property = { '--archive': 'archive', '--archive-sha256': 'archiveSha256', '--lan-host': 'lanHost' }[name];
  assert.ok(property && argumentsList[index + 1] && !argumentsList[index + 1].startsWith('--'), '未知参数或参数缺值：' + name);
  options[property] = argumentsList[++index];
}
assert.equal(seen.has('--archive'), seen.has('--archive-sha256'), '替换正式归档必须同时提供路径和摘要');
assert.match(options.archiveSha256, /^[a-fA-F0-9]{64}$/);
const profile = options.release ? 'release' : 'debug';
const runId = randomUUID();
const artifacts = resolve(root, 'artifacts', 'browser-device-tools-acceptance-' + profile + '-' + runId);
const reportPath = join(artifacts, 'report.json');
await mkdir(artifacts, { recursive: true });
const report = { run_id: runId, timestamp: new Date().toISOString(), profile, platform: process.platform,
  node_version: process.version, passed: false, cleanup_errors: [],
  scope: '正式示例TGZ + 生产ESM + 本机真实非安全LAN浏览器 + 真实协议3模拟提供者；不含产品UI、另一客户端、真机、MCP或长时执行' };
let temporary; let child; let observer; let bridge; let fixtures; let backendBase;

async function reservePort() {
  const server = createServer();
  await new Promise((done, failed) => { server.once('error', failed); server.listen(0, '127.0.0.1', done); });
  const port = server.address().port;
  await new Promise((done, failed) => server.close((error) => error ? failed(error) : done())); return port;
}
async function json(base, path, method = 'GET') {
  const response = await fetch(base + path, { method, signal: AbortSignal.timeout(12000) });
  const envelope = await response.json();
  assert.ok(response.ok, '真实后端请求失败：' + response.status + '/' + path);
  assert.ok(envelope.log_id && envelope.log_id === response.headers.get('x-deviceforge-log-id'));
  return envelope.data;
}
async function ready(base) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || report.backend_process.spawn_error) throw new Error('真实后端就绪前已退出');
    try { await json(base, '/api/v2/operations'); return; } catch {}
    await delay(50);
  }
  throw new Error('真实后端未在有限时间就绪');
}
async function driverInputs() {
  const names = ['README.md', 'bridge.mjs', 'browser-checks.mjs', 'consumer.mjs', 'fixtures.mjs',
    'frozen-inputs.json', 'harness.mjs', 'probe-context.mjs', 'run.mjs'];
  return Promise.all(names.map(async (path) => ({ path, ...await digest(new URL('./' + path, import.meta.url)) })));
}
async function sharedInputs() {
  const paths = ['cli/src/network.mjs', 'scripts/unified-discovery-browser/browser-driver.mjs',
    'scripts/unified-discovery-browser/lifecycle.mjs', 'scripts/unified-discovery/fixtures.mjs',
    'scripts/unified-discovery/node-provider.mjs', 'scripts/device-provider/client.mjs',
    'scripts/device-provider/fixtures.mjs', 'backend/scripts/online-plugins/fixtures.mjs'];
  return Promise.all(paths.map(async (path) => ({ path, ...await digest(resolve(root, path)) })));
}
function checkDeliveredSources() {
  report.delivered_sources = [];
  for (const file of report.inputs_before.files.filter((entry) => entry.path.includes('/src/'))) {
    const asset = file.path.slice('examples/browser-device-tools/'.length);
    const matches = report.bridge.requests.filter((entry) => entry.method === 'GET' && entry.status === 200
      && entry.path.startsWith('/api/v2/browser-plugins/browser_device_tools/runs/') && entry.path.endsWith('/assets/' + asset));
    assert.ok(matches.length >= 3, '默认/缺省/重载路径未全部读取冻结模块：' + asset);
    for (const entry of matches) assert.equal(entry.sha256, file.sha256, '在线安装代码与冻结源码不一致：' + asset);
    report.delivered_sources.push({ source: asset, expected_sha256: file.sha256,
      responses: matches.map((entry) => ({ path: entry.path, sha256: entry.sha256 })) });
  }
}

try {
  report.stage = '核对冻结输入与LAN地址';
  report.inputs_before = await verifyFrozenInputs(); report.driver_inputs_before = await driverInputs();
  report.shared_inputs_before = await sharedInputs();
  // 与 CLI 使用同一实际网卡地址方法，排除整个 127/8，不能无 LAN 时静默回退。
  const candidates = networkConfig('0.0.0.0', 7030, 7032).urls.map((item) => new URL(item.web).hostname)
    .filter((host) => !host.startsWith('127.'));
  assert.ok(candidates.length > 0, '没有实际非loopback IPv4，不能执行LAN验收');
  const lanHost = options.lanHost ?? candidates[0]; assert.ok(candidates.includes(lanHost), '--lan-host 必须属于本机实际非内部IPv4网卡');
  report.lan = { chosen_host: lanHost, candidates, second_machine_tested: false };
  temporary = await mkdtemp(join(tmpdir(), 'deviceforge-example-acceptance-'));
  report.temporary = temporary;
  fixtures = await createFixtures({ archivePath: resolve(root, options.archive), archiveSha256: options.archiveSha256,
    directory: join(temporary, 'controls'), artifacts, runId, report });
  report.official_archive = { path: relative(root, resolve(root, options.archive)), sha256: options.archiveSha256.toLowerCase() };
  const binary = resolve(root, 'backend/target', profile, process.platform === 'win32' ? 'apk-server.exe' : 'apk-server');
  report.backend_host = { path: relative(root, binary), ...await digest(binary) };
  const dist = resolve(root, 'frontend/dist');
  report.production_host = { path: 'frontend/dist/assets/plugin-host.js', ...await digest(join(dist, 'assets/plugin-host.js')) };
  const port = await reservePort(); const base = 'http://127.0.0.1:' + port; backendBase = base;
  report.backend_process = {};
  child = spawn(binary, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, APK_API_TOKEN: '', APK_BIND: '127.0.0.1:' + port, APK_DATA_DIR: join(temporary, 'data'),
    APK_PLUGIN_DIR: join(temporary, 'server-plugins'), APK_BROWSER_PLUGIN_DIR: join(temporary, 'browser-plugins'),
    DEVICEFORGE_NODE: process.execPath,
  } });
  observer = observeChild(child, report.backend_process); await ready(base);
  bridge = await createBridge({ base, lanHost, dist, fixtures: fixtures.packages, report,
    configuration: { ...fixtures.configuration, lanHost }, control: providerControl(fixtures.provider, report) });
  report.page_url = bridge.origin + '/__verification';
  report.stage = '真实LAN生产浏览器'; report.browser_runtime = {};
  const expression = `(async () => { const module = await import('/__acceptance/harness.mjs'); return module.verifyExample(); })()`;
  report.browser = await runBrowser({ pageUrl: report.page_url, expression,
    profileDirectory: join(temporary, 'browser-profile'), evidence: report.browser_runtime,
    observeResult: (value) => { report.browser = value; } });
  assert.equal(report.browser.passed, true, '浏览器场景失败，详见逐项证据');
  assert.deepEqual(report.bridge.errors, []); checkDeliveredSources();
  const actualLogIds = new Set(report.bridge.requests.map((entry) => entry.logId).filter(Boolean));
  for (const logId of report.browser.response_log_ids) assert.ok(actualLogIds.has(logId), 'SDK日志ID未关联真实HTTP响应');
  report.stage = '验收桥与真实后端退出';
  await bridge.close(); bridge = undefined;
  await json(base, '/api/v2/system/shutdown', 'POST'); await observer.wait(10000);
  report.backend_process.normal_exit = normalExit(report.backend_process);
  assert.equal(report.backend_process.normal_exit, true, '后端未正常退出');
  report.passed = true;
} catch (error) { report.error = { name: error.name, message: error.message.slice(0, 1500) }; }
finally {
  if (bridge) {
    try { await bridge.close(); }
    catch (error) { report.cleanup_errors.push({ stage: 'bridge', message: error.message }); report.passed = false; }
  }
  if (observer && child.exitCode === null && child.signalCode === null) {
    try { await json(backendBase, '/api/v2/system/shutdown', 'POST'); await observer.wait(10000); }
    catch (error) {
      report.cleanup_errors.push({ stage: 'backend_shutdown', message: error.message }); report.passed = false;
      try { await observer.force(); }
      catch (forced) { report.cleanup_errors.push({ stage: 'owned_backend_force', message: forced.message }); }
    }
  }
  if (report.backend_process) {
    report.backend_process.normal_exit = normalExit(report.backend_process);
    if (!report.backend_process.normal_exit) report.passed = false;
  }
  try {
    await preserveProvider(fixtures?.provider, artifacts, report);
    if (report.provider) {
      report.provider.processes = report.provider.events.filter((entry) => entry.kind === 'started').map((entry) => ({
        pid: entry.pid, request_id: entry.request_id, label: entry.label, exited: exited(entry.pid),
      }));
      if (report.provider.processes.some((entry) => !entry.exited)) {
        report.passed = false; report.cleanup_errors.push({ stage: 'provider_pid', message: '本次记录的提供者PID仍存在；不强杀未直接拥有的PID' });
      }
    }
    report.inputs_after = await verifyFrozenInputs();
    if (report.inputs_before) assert.equal(report.inputs_after.aggregate, report.inputs_before.aggregate);
    report.driver_inputs_after = await driverInputs();
    if (report.driver_inputs_before) assert.deepEqual(report.driver_inputs_after, report.driver_inputs_before);
    report.shared_inputs_after = await sharedInputs();
    if (report.shared_inputs_before) assert.deepEqual(report.shared_inputs_after, report.shared_inputs_before);
    if (report.production_host) {
      report.production_host_after = await digest(resolve(root, report.production_host.path));
      assert.equal(report.production_host_after.sha256, report.production_host.sha256, '运行期间生产host发生变化');
    }
    if (report.backend_host) {
      report.backend_host_after = await digest(resolve(root, report.backend_host.path));
      assert.equal(report.backend_host_after.sha256, report.backend_host.sha256, '运行期间后端程序发生变化');
    }
  } catch (error) { report.cleanup_errors.push({ stage: 'evidence', message: error.message }); report.passed = false; }
  if (temporary) {
    if (report.passed) {
      try {
        const within = relative(resolve(tmpdir()), resolve(temporary));
        assert.ok(within && !isAbsolute(within) && within !== '..' && !within.startsWith('..' + '/') && !within.startsWith('..' + '\\'));
        await rm(temporary, { recursive: true, force: false, maxRetries: 5, retryDelay: 200 });
        report.temporary_removed = true;
      } catch (error) { report.cleanup_errors.push({ stage: 'temporary', message: error.message }); report.passed = false; report.temporary_retained = temporary; }
    } else report.temporary_retained = temporary;
  }
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
}
if (!report.passed) process.exitCode = 1;
console.log(JSON.stringify({ passed: report.passed, report: reportPath, stage: report.stage, error: report.error }));
