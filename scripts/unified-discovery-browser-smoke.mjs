import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createFixtures, providerId } from './unified-discovery-browser/fixtures.mjs';
import { createBridge } from './unified-discovery-browser/bridge.mjs';
import { runBrowser } from './unified-discovery-browser/browser-driver.mjs';
import { createRawNodeControl } from './unified-discovery-browser/raw-node-control.mjs';
import { digest, observeChild, normalExit } from './unified-discovery-browser/lifecycle.mjs';

// 仅供主代理串行验收：消费已有二进制及 production host，不构建、不使用 Vite。
const root = fileURLToPath(new URL('../', import.meta.url));
assert.ok(process.argv.slice(2).every((value) => value === '--release'), '仅支持 --release');
const profile = process.argv.includes('--release') ? 'release' : 'debug';
const binary = resolve(root, 'backend/target', profile, process.platform === 'win32' ? 'apk-server.exe' : 'apk-server');
const dist = resolve(root, 'frontend/dist');
await mkdir(resolve(root, 'artifacts'), { recursive: true });
const artifacts = await mkdtemp(join(root, 'artifacts', `unified-discovery-browser-${profile}-`));
const reportPath = join(artifacts, 'report.json');
const temporary = await mkdtemp(join(tmpdir(), 'deviceforge-unified-browser-'));
const pluginRoot = join(temporary, 'server-plugins');
const report = { started_at: new Date().toISOString(), profile, platform: process.platform, passed: false,
  command: ['node', 'scripts/unified-discovery-browser-smoke.mjs', ...(profile === 'release' ? ['--release'] : [])],
  node_version: process.version, backend_process: {}, browser_process: {},
  scope: '真实生产浏览器、API3 原文、完整替换、自己的回执、A/B 本地修订保护、两端热卸载；模拟提供者，无产品 UI 或真机',
  artifact_directory: relative(root, artifacts) };
let child; let observer; let bridge; let base; let fixtures; let inputs; let rawNodeControl;

async function tree(directory, suffixes) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await tree(path, suffixes));
    else if (entry.isFile() && suffixes.some((suffix) => entry.name.endsWith(suffix))) files.push(path);
  }
  return files.sort();
}
async function manifest(paths) {
  const result = [];
  for (const path of paths) result.push({ path: relative(root, path).replaceAll('\\', '/'), ...await digest(path) });
  return result;
}
async function reservePort() {
  const server = createServer();
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const port = server.address().port;
  await new Promise((done, reject) => server.close((error) => error ? reject(error) : done())); return port;
}
async function api(path, options = {}) {
  const response = await fetch(`${base}${path}`, { ...options, signal: AbortSignal.timeout(3000) });
  const body = await response.json();
  assert.ok(response.ok, `真实宿主接口失败 ${response.status}/${body.error?.code}`);
  assert.ok(body.log_id && body.log_id === response.headers.get('x-deviceforge-log-id'), '宿主真实日志 ID 错误');
  return body.data;
}
async function ready() {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (report.backend_process.exit || report.backend_process.spawn_error) throw new Error('真实宿主提前退出或启动失败');
    try { await api('/api/v2/operations'); return; } catch {} await delay(50);
  }
  throw new Error('真实宿主未就绪');
}
async function collectProcessEvidence(strict) {
  const path = join(pluginRoot, providerId, 'events.jsonl');
  let content;
  try { content = await readFile(path); }
  catch (error) { if (!strict && error.code === 'ENOENT') return null; throw error; }
  assert.ok(content.length <= 1024 * 1024, '夹具进程证据超限');
  const events = content.toString('utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  await writeFile(join(artifacts, 'provider-events.jsonl'), content);
  const key = (event) => `${event.pid}/${event.request_id}`;
  const started = events.filter((event) => event.kind === 'started');
  const exits = events.filter((event) => event.kind === 'exit');
  const responses = events.filter((event) => event.kind === 'response');
  const missing = started.filter((event) => exits.filter((entry) => key(entry) === key(event) && entry.code === 0).length !== 1
    || responses.filter((entry) => key(entry) === key(event)).length !== 1);
  report.provider_processes = { events, started: started.length, exits: exits.length,
    source: '协议夹具自身退出记录；宿主和浏览器另记录 OS exit/close',
    passed: started.length > 0 && missing.length === 0 && exits.length === started.length && exits.every((event) => event.code === 0) };
  if (strict) assert.equal(report.provider_processes.passed, true, '夹具进程退出链不完整');
  return { started: started.length, exits: exits.length, passed: report.provider_processes.passed };
}

try {
  report.stage = '冻结实际输入摘要';
  inputs = [...new Set([fileURLToPath(import.meta.url),
    resolve(root, 'backend/scripts/online-plugins/fixtures.mjs'),
    resolve(root, 'scripts/unified-discovery/fixtures.mjs'),
    resolve(root, 'scripts/unified-discovery/node-provider.mjs'),
    resolve(root, 'scripts/unified-discovery/README.md'),
    resolve(root, 'scripts/device-provider/fixtures.mjs'),
    resolve(root, 'scripts/device-provider/client.mjs'),
    resolve(root, 'backend/docs/统一发现第二批契约.md'),
    resolve(root, 'frontend/docs/统一发现发布回执消费边界.md'),
    ...await tree(resolve(root, 'scripts/unified-discovery-browser'), ['.mjs', '.md']),
    ...await tree(resolve(root, 'frontend/src'), ['.ts', '.svelte']),
    ...await tree(resolve(root, 'backend/crates'), ['.rs', '.toml']),
    resolve(root, 'backend/Cargo.toml'), resolve(root, 'backend/Cargo.lock'),
    ...await tree(dist, ['.js', '.css', '.html']), binary,
  ])].sort();
  report.inputs_before = await manifest(inputs);
  report.node_runtime = { path: process.execPath, version: process.version, ...await digest(process.execPath) };
  report.backend_host = { path: relative(root, binary), ...await digest(binary) };
  report.production_host = { path: 'frontend/dist/assets/plugin-host.js', ...await digest(join(dist, 'assets/plugin-host.js')) };
  fixtures = await createFixtures(join(temporary, 'raw-node-control')); report.packages = [];
  for (const fixture of fixtures) {
    const archive = join(artifacts, `${fixture.fixtureName ?? fixture.kind}.tgz`); await writeFile(archive, fixture.archive);
    report.packages.push({ kind: fixture.kind, id: fixture.id, archive: relative(root, archive), ...await digest(archive),
      generator: fixture.generator ?? 'scripts/unified-discovery-browser/fixtures.mjs::createFixtures',
      files: fixture.files?.map((file) => ({ path: file.path, bytes: Buffer.byteLength(file.bytes) })) ?? null });
  }
  rawNodeControl = createRawNodeControl(fixtures.find((item) => item.rawNode).rawNode, artifacts, report);
  report.stage = '启动本次真实宿主';
  const port = await reservePort(); base = `http://127.0.0.1:${port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(APK_|DEVICEFORGE_)/i.test(name)));
  Object.assign(env, { APK_BIND: `127.0.0.1:${port}`, APK_DATA_DIR: join(temporary, 'data'),
    APK_PLUGIN_DIR: pluginRoot, APK_BROWSER_PLUGIN_DIR: join(temporary, 'browser-plugins'),
    DEVICEFORGE_NODE: process.execPath, DEVICEFORGE_HTTP_RATE: '10000' });
  child = spawn(binary, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
  observer = observeChild(child, report.backend_process); await ready();
  bridge = await createBridge({ base, dist, fixtures, report, collectProcessEvidence, rawNodeControl });
  report.stage = '真实生产浏览器行为';
  report.browser = await runBrowser({ pageUrl: `${bridge.origin}/__verification`,
    expression: '(async () => (await import("/__harness.mjs")).verifyUnifiedDiscovery())()',
    profileDirectory: join(temporary, 'browser-profile'), evidence: report.browser_process,
    observeResult: (result) => { report.browser = result; } });
  assert.equal(report.browser?.passed, true, '真实浏览器行为失败，详见逐项证据');
  const ownerRejection = report.browser.ownerUnloadResult?.error;
  if (ownerRejection?.kind === 'http') {
    assert.ok(report.bridge.requests.some((request) => request.method === 'POST'
      && request.path === '/api/v2/device-providers/raw_node_browser_provider/refresh'
      && request.status === 409 && request.errorCode === 'conflict' && request.logId === ownerRejection.logId),
    '公开错误必须关联本次真实409 conflict响应，不能靠浏览器文字推断');
  }
  assert.equal(report.provider_processes?.passed, true, '删除前未保存夹具退出证据');
  assert.equal(report.raw_node.cleanups.length, 11, 'RAW-NODE 清理链未覆盖全部场景');
  assert.equal(report.bridge.errors.length, 0, '验收代理发生错误');
  report.stage = '关闭本次代理与宿主';
  await bridge.close(); bridge = undefined;
  await api('/api/v2/system/shutdown', { method: 'POST' });
  await observer.wait(10000); assert.equal(normalExit(report.backend_process), true, 'Rust 未正常退出');
  report.passed = true;
} catch (error) { report.error = String(error.message).slice(0, 1000); }
finally {
  if (!report.provider_processes && child) {
    try { await collectProcessEvidence(false); }
    catch (error) { report.provider_evidence_error = String(error.message).slice(0, 300); }
  }
  if (bridge) {
    try { await bridge.close(); }
    catch (error) { report.bridge_cleanup_error = error.message; report.passed = false; }
  }
  if (observer && !report.backend_process.close) {
    try {
      if (!report.backend_process.exit && !report.backend_process.spawn_error) await api('/api/v2/system/shutdown', { method: 'POST' });
      await observer.wait(10000);
    } catch {
      try { await observer.force(); }
      catch (error) { report.backend_cleanup_error = error.message; }
    }
  }
  if (observer) report.backend_process.normal_exit = normalExit(report.backend_process);
  if (rawNodeControl) {
    try { await rawNodeControl.save(); }
    catch (error) { report.raw_node_evidence_error = error.message; report.passed = false; }
  }
  if (!report.backend_process.normal_exit || !report.browser_process.normal_exit) report.passed = false;
  if (inputs) {
    try {
      const finalInputs = [...new Set([...inputs,
        ...await tree(resolve(root, 'scripts/unified-discovery-browser'), ['.mjs', '.md']),
        ...await tree(resolve(root, 'frontend/src'), ['.ts', '.svelte']),
        ...await tree(resolve(root, 'backend/crates'), ['.rs', '.toml']),
        ...await tree(dist, ['.js', '.css', '.html']),
      ])].sort();
      report.inputs_after = await manifest(finalInputs);
      report.inputs_stable = JSON.stringify(report.inputs_before) === JSON.stringify(report.inputs_after);
      if (!report.inputs_stable) report.passed = false;
    } catch (error) { report.input_check_error = error.message; report.passed = false; }
  }
  const within = relative(tmpdir(), temporary);
  if (!within || isAbsolute(within) || within.startsWith('..') || !within.startsWith('deviceforge-unified-browser-')) {
    report.cleanup_error = '本次临时目录边界校验失败'; report.passed = false;
  } else if (report.passed) {
    try { await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    catch (error) { report.cleanup_error = error.code; report.passed = false; }
  }
  if (!report.passed) { report.temporary_retained = temporary; process.exitCode = 1; }
  report.finished_at = new Date().toISOString();
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}
console.log(JSON.stringify({ passed: report.passed, report: reportPath, error: report.error }));
