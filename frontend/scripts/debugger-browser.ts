import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createDefaultsBrowser, listenerReleased } from './plugin-defaults-browser/browser.ts';
import { debuggerObject as obj, debuggerText as text } from './debugger-fixture-contract.ts';
import { runDebuggerInstallationAcceptance } from './debugger-installation-acceptance.ts';
import type { DebuggerInstallationAcceptanceResult } from './debugger-installation-acceptance.ts';
import { createDebuggerPackages, debuggerDigest, debuggerInside, debuggerProject,
  debuggerPublicEntries, officialDebuggerPackage, parseDebuggerFreeze, verifyDebuggerFreeze } from './debugger-fixture.ts';

interface OwnHost {
  readonly child: ChildProcess;
  ready(): Promise<void>;
}
interface HostModule {
  reservePort(): Promise<number>;
  startHost(options: { root: string; binary: string; directory: string; report: Record<string, unknown>; port: number; ordinal: number }): Promise<OwnHost>;
  finishOwnHost(host: OwnHost): Promise<void>;
}
type DebuggerBrowser = Awaited<ReturnType<typeof createDefaultsBrowser>>;
const hostModule = (value: unknown): value is HostModule =>
  ['reservePort', 'startHost', 'finishOwnHost'].every((name) => typeof obj(value)[name] === 'function');
const execute = promisify(execFile);
const argument = process.argv.indexOf('--frozen');
assert.ok(argument >= 0 && process.argv[argument + 1],
  '真实联调尚未冻结。用法：node scripts/debugger-browser.ts --frozen <主代理确认的冻结清单.json>；准备夹具使用 debugger-fixture.ts');
const frozen = parseDebuggerFreeze(JSON.parse(await readFile(resolve(process.argv[argument + 1] ?? ''), 'utf8')));
await verifyDebuggerFreeze(frozen);
const run = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
const output = join(debuggerProject, 'artifacts', 'debugger-20261028', run);
const directory = join(output, 'host'), profile = join(output, 'browser-profile');
await mkdir(output, { recursive: true });
const report: Record<string, unknown> = { started_at: new Date().toISOString(), passed: false, output,
  scope: '新冻结底座、受控空设备宿主、两个独立浏览器插件和官方Debugger；不代表真机、市场发布或视觉审核通过',
  frozen, driver_pid: process.pid, requests: [], captures: [], cleanup: [] };
const requests: Record<string, unknown>[] = []; report['requests'] = requests;
const cleanup: Record<string, unknown>[] = []; report['cleanup'] = cleanup;
const captures: Record<string, unknown>[] = []; report['captures'] = captures;
const evidence: Record<string, unknown> = { socket_events: [] }; report['browser'] = evidence;
const module: unknown = await import(pathToFileURL(join(debuggerProject, 'scripts/unified-discovery-smoke/host.mjs')).href);
assert.ok(hostModule(module));
let host: OwnHost | null = null;
let browser: DebuggerBrowser | null = null;
let secondary: Awaited<ReturnType<DebuggerBrowser['newPage']>> | null = null;
let hostPort = 0, webPort = 0, rpcId = 0;
let stage = '独占进程检查';
let failure: unknown;
const server = createServer();
const hostBase = () => `http://127.0.0.1:${hostPort}`;
function browserListenerReleased() {
  const listener = evidence['listener'];
  return listener !== null && typeof listener === 'object' && 'released' in listener && listener.released === true;
}

/** 查询可重复，所有安装、动作、更新与卸载仅派发一次。 */
async function api(path: string, method = 'GET', body?: Uint8Array | Record<string, unknown>, media?: string) {
  const response = await fetch(hostBase() + path, { method, signal: AbortSignal.timeout(20000),
    redirect: 'error', ...(body === undefined ? {} : { body: body instanceof Uint8Array ? Buffer.from(body) : JSON.stringify(body) }),
    headers: { 'content-type': media ?? 'application/json' } });
  const value = obj(await response.json()), logId = response.headers.get('x-deviceforge-log-id');
  requests.push({ method, path, status: response.status, log_id: logId });
  assert.equal(value['log_id'], logId); assert.ok(logId);
  assert.ok(response.ok, `${method} ${path} ${JSON.stringify(value['error'])}`);
  return value['data'];
}
async function mcp(name: string, input: Record<string, unknown>) {
  const id = ++rpcId;
  const response = await fetch(hostBase() + '/mcp', { method: 'POST',
    signal: AbortSignal.timeout(name === 'deviceforge.debug_reload' ? 45000 : 20000),
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', origin: hostBase(),
      'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': name },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: input,
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'debugger-local-acceptance', version: '1' },
        'io.modelcontextprotocol/clientCapabilities': {} } } }) });
  const value = obj(await response.json()), result = obj(value['result']);
  const logId = response.headers.get('x-deviceforge-log-id');
  requests.push({ transport: 'mcp', name, status: response.status, log_id: logId });
  assert.equal(response.status, 200); assert.equal(value['id'], id); assert.equal(value['error'], undefined);
  assert.equal(result['isError'], false, `MCP ${name} 失败：${JSON.stringify(result['structuredContent'])}`); assert.ok(logId);
  assert.equal(obj(result['_meta'])['deviceforge/log_id'], logId);
  return result['structuredContent'];
}
async function noMatchingProcess(needle: string, description: string) {
  const escaped = needle.replaceAll("'", "''");
  const result = await execute('powershell.exe', ['-NoProfile', '-Command',
    `$match='${escaped}'; @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains($match) }).Count`], { windowsHide: true });
  assert.equal(Number(result.stdout.trim()), 0, description + '已有同命令进程，拒绝再启动');
}
async function verifySuiteReloadAndRestore(accepted: DebuggerInstallationAcceptanceResult) {
  const directory = obj(await mcp('deviceforge.debug_targets', {}));
  const plugins = directory['server_plugins']; assert.ok(Array.isArray(plugins));
  const selected = plugins.map((item: unknown) => obj(item)).find(item => item['id'] === 'demo_debugger_server');
  assert.ok(selected);
  const target = { target_kind: 'server', instance_id: null, plugin_id: text(selected['id']),
    generation: text(selected['generation']), version: text(selected['version']) };
  const session = obj(await mcp('deviceforge.debug_session', { action: 'open', target }));
  const sessionId = text(session['session_id']);
  try {
    const reloaded = obj(await mcp('deviceforge.debug_reload', { session_id: sessionId,
      parameters: { confirmed: true, follow: true, timeout_ms: 30000 } }));
    assert.equal(reloaded['state'], 'succeeded');
    assert.notEqual(obj(reloaded['target'])['generation'], target.generation);
    const installed = obj(await api(`/api/v2/plugin-installations/${accepted.suiteId}`));
    assert.equal(installed['revision'], accepted.report.updated.revision, '整套重载不得改变代码修订');
    const previous = obj(await api(`/api/v2/plugin-installations/${accepted.suiteId}/previous-successful?expected_revision=${accepted.report.updated.revision}`));
    const restoredJob = obj(await mcp('installation.restore_successful', { id: accepted.suiteId,
      expected_revision: accepted.report.updated.revision, confirmed: true }));
    const jobId = text(restoredJob['id']);
    const deadline = Date.now() + 15000;
    let last = restoredJob;
    while (Date.now() < deadline && ['queued', 'running'].includes(text(last['status']))) {
      await new Promise<void>((done) => setTimeout(done, 50));
      last = obj(await api(`/api/v2/jobs/${jobId}`));
    }
    assert.equal(last['status'], 'succeeded', `恢复任务未成功：${JSON.stringify(last['error'])}`);
    const after = obj(await api(`/api/v2/plugin-installations/${accepted.suiteId}`));
    assert.equal(after['revision'], accepted.report.initial.revision, '必须恢复真实上一成功构建');
    assert.equal(after['enabled'], true, '恢复应保留整套启用意图');
    report['suite_reload_restore'] = { reloaded, previous, job_id: jobId,
      restored_revision: after['revision'], business_data_rollback: false };
  } finally {
    await mcp('deviceforge.debug_session', { action: 'close', session_id: sessionId });
  }
}
async function page(expression: string) {
  assert.ok(browser); return browser.evaluate(`window.__debuggerHarness.${expression}`);
}
try {
  // 先检查完全相同的宿主路径；禁止复用未归属本轮的宿主，也不终止它。
  await noMatchingProcess(frozen.host.path, '冻结宿主');
  await noMatchingProcess(profile, '独占浏览器');
  hostPort = await module.reservePort();
  assert.ok(![7031, 5173, 5186].includes(hostPort));
  stage = '启动同一冻结宿主';
  host = await module.startHost({ root: debuggerProject, binary: frozen.host.path, directory, report, port: hostPort, ordinal: 1 });
  await host.ready();
  assert.deepEqual(await api('/api/v2/plugins'), []);
  assert.deepEqual(await api('/api/v2/devices'), []);
  assert.deepEqual(await api('/api/v2/device-providers'), []);
  stage = '原HTTP安装入口导入受控包';
  const packages = await createDebuggerPackages();
  const serverPackage = packages.find((entry) => entry.kind === 'server'); assert.ok(serverPackage);
  await api('/api/v2/plugin-packages/server?format=tgz', 'POST', serverPackage.bytes, 'application/gzip');
  await api(`/api/v2/plugins/${serverPackage.id}/load`, 'POST', {});
  const browsers = packages.filter((entry) => entry.kind === 'browser');
  for (const entry of [browsers[0], browsers[2]]) {
    assert.ok(entry); await api('/api/v2/plugin-packages/browser?format=zip', 'POST', entry.bytes, 'application/zip');
  }
  const official = await officialDebuggerPackage(frozen);
  await api('/api/v2/plugin-packages/browser?format=zip', 'POST', official, 'application/zip');
  report['packages'] = packages.map((entry) => ({ id: entry.id, kind: entry.kind, sha256: debuggerDigest(entry.bytes), bytes: entry.bytes.length }));
  report['official_package'] = { sha256: debuggerDigest(official), bytes: official.length };
  stage = '共用离线导入与MCP整套安装更新';
  const installationAcceptance = await runDebuggerInstallationAcceptance({ api, mcp });
  report['installation_acceptance'] = installationAcceptance;
  stage = '完整功能Debugger整套重载与上一成功代码包恢复';
  await verifySuiteReloadAndRestore(installationAcceptance);
  stage = '启动受控浏览器入口';
  const files = new Map(frozen.frontend.files.map((entry) => ['/' + entry.path, entry]));
  const styles = frozen.frontend.files.filter((entry) => entry.path.endsWith('.css'));
  server.on('request', (request, response) => {
    void (async () => {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (path.startsWith('/api/') || path === '/mcp') {
        const pieces: Buffer[] = [];
        let size = 0;
        for await (const value of request) { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value)); size += bytes.length; assert.ok(size < 16 * 1024 * 1024); pieces.push(bytes); }
        const lifetime = new AbortController();
        response.once('close', () => { if (!response.writableEnded) lifetime.abort(); });
        const upstream = await fetch(hostBase() + (request.url ?? '/'), {
          method: request.method ?? 'GET', signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(45000)]),
          headers: { 'content-type': request.headers['content-type'] ?? 'application/json', accept: request.headers.accept ?? 'application/json' },
          ...(pieces.length ? { body: Buffer.concat(pieces) } : {}),
        });
        response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
        response.end(Buffer.from(await upstream.arrayBuffer())); return;
      }
      if (path === '/') {
        response.setHeader('content-type', 'text/html; charset=utf-8');
        const imports = Object.fromEntries(Object.entries(debuggerPublicEntries).map(([key, path]) => [key, '/' + path]));
        response.end(`<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>插件调试器受控验收</title>${styles.map((entry) => `<link rel="stylesheet" href="/${entry.path}">`).join('')}<script type="importmap">${JSON.stringify({ imports })}</script><body><script>window.__debuggerErrors=[];addEventListener('error',e=>window.__debuggerErrors.push(e.message));addEventListener('unhandledrejection',e=>window.__debuggerErrors.push(String(e.reason)));</script><script type="module">import * as harness from '/assets/debugger-browser-harness.js';window.__debuggerHarness=harness;</script></body></html>`); return;
      }
      const file = files.get(path);
      if (!file) { response.writeHead(404); response.end(); return; }
      const content = await readFile(join(frozen.frontend.directory, file.path));
      response.setHeader('content-type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'application/octet-stream');
      response.end(content);
    })().catch((error: unknown) => { requests.push({ proxy_error: String(error), path: request.url }); if (!response.headersSent) response.writeHead(502); response.end(); });
  });
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address(); assert.ok(address && typeof address !== 'string'); webPort = address.port;
  assert.ok(![7031, 5173, 5186].includes(webPort));
  browser = await createDefaultsBrowser(debuggerProject, profile, evidence);
  const webBase = `http://127.0.0.1:${webPort}`;
  await browser.resize(1424, 805);
  await browser.navigate(webBase + '/');
  await browser.wait('!!window.__debuggerHarness', '新冻结调试验收入口');
  await page(`mount(${JSON.stringify(webBase)})`);
  await page('enable()');
  const viaHttp = obj(await api('/api/v2/debugger/call', 'POST', { name: 'deviceforge.debug_targets', input: {} }));
  const viaMcp = obj(await mcp('deviceforge.debug_targets', {}));
  assert.deepEqual(viaMcp, viaHttp, 'HTTP/MCP 必须消费同一调试底座状态');
  report['shared_state'] = viaMcp;
  for (const name of ['select()', 'structureAndActions()', 'beginPick()', 'finishPick()', 'report()', 'invokeService()', 'invokeService(true)', 'inspectServerAndInvoke()', 'beforeUpdate()']) {
    stage = name; report[name] = await page(name);
  }
  stage = '包更新旧引用拒绝';
  const update = browsers[1]; assert.ok(update);
  await page(`update(${JSON.stringify(Buffer.from(update.bytes).toString('base64'))})`);
  report['updated_report'] = await page('report()');
  stage = '第二标签页明确实例与路由隔离';
  secondary = await browser.newPage(webBase + '/');
  await secondary.wait('!!window.__debuggerHarness');
  await secondary.evaluate(`window.__debuggerHarness.mount(${JSON.stringify(webBase)})`);
  const second = obj(await secondary.evaluate('window.__debuggerHarness.enableSecondary()'));
  const first = obj(await page('snapshot()'));
  assert.notEqual(obj(second['target'])['instance_id'], obj(first['bridge'])['instanceId']);
  const cross = obj(await page(`call('inspect',${JSON.stringify({ session_id: second['session_id'], parameters: {} })})`));
  const roots = obj(cross['data'])['roots']; assert.ok(Array.isArray(roots));
  assert.equal(roots.length, 1,
    '经第一标签页提交第二标签页会话时必须仍由第二标签页检查');
  report['multiple_tabs'] = { second, cross };
  await secondary.evaluate('window.__debuggerHarness.dispose()'); await secondary.close(); secondary = null;
  stage = '官方面板focus与截图'; await page('focusOfficial()');
  const image = join(output, 'debugger-1424x805.png'); await browser.capture(image, 1424, 805);
  captures.push({ path: image, width: 1424, height: 805, visual_review: '等待主代理安排视觉代理，不作图片审核结论' });
  const before = obj(await page('officialGeometry()'));
  const drag = obj(before['drag']);
  for (const key of ['x', 'y', 'width', 'height']) assert.equal(typeof before[key], 'number');
  const point = (value: Record<string, unknown>) => {
    const x = value['x'], y = value['y']; assert.equal(typeof x, 'number'); assert.equal(typeof y, 'number');
    assert.ok(typeof x === 'number' && typeof y === 'number'); return { x, y };
  };
  const start = point(drag); await browser.drag(start, { x: start.x - 40, y: start.y + 24 });
  const moved = obj(await page('officialGeometry()'));
  assert.notEqual(moved['x'], before['x'], '真实指针拖动没有移动面板');
  const handle = point(obj(moved['resize'])); await browser.drag(handle, { x: handle.x - 80, y: handle.y - 40 });
  const resized = obj(await page('officialGeometry()'));
  assert.notEqual(resized['width'], moved['width'], '真实指针没有缩放面板');
  await page("officialControl('keyboard')"); await browser.pressKey('ArrowRight'); await browser.pressKey('Enter');
  const keyed = obj(await page('officialGeometry()'));
  assert.equal(typeof resized['width'], 'number'); assert.equal(typeof keyed['width'], 'number');
  assert.ok(typeof resized['width'] === 'number' && typeof keyed['width'] === 'number');
  assert.equal(keyed['width'], resized['width'] + 8, '真实方向键没有按公开规则调整尺寸');
  report['official_geometry'] = { before, moved, resized, keyed };
  const narrow = join(output, 'debugger-940x760.png'); await browser.capture(narrow, 940, 760);
  captures.push({ path: narrow, width: 940, height: 760, visual_review: '等待视觉代理' });
  report['narrow_geometry'] = await page('officialGeometry()');
  await page("officialControl('collapse')");
  const ball = join(output, 'debugger-ball-1424x805.png'); await browser.capture(ball, 1424, 805);
  captures.push({ path: ball, width: 1424, height: 805, visual_review: '等待视觉代理' });
  stage = '官方Debugger卸载'; await page('unloadOfficial()');
  stage = '显式重连无动作重放'; await page('reconnectExplicitly()');
  report['harness'] = await page('snapshot()');
  assert.deepEqual(await browser.evaluate('window.__debuggerErrors'), [], '页面存在未处理错误');
  await verifyDebuggerFreeze(frozen);
  report['business_passed'] = true;
} catch (error) {
  failure = error; report['failure'] = { stage, message: error instanceof Error ? error.message : String(error) };
} finally {
  if (secondary) {
    try { await secondary.evaluate('window.__debuggerHarness.dispose()'); await secondary.close(); }
    catch (error) { cleanup.push({ kind: 'secondary_tab', released: false, error: String(error) }); failure ??= error; }
  }
  if (browser) {
    try { report['disposed'] = await page('dispose()'); } catch (error) { cleanup.push({ kind: 'harness', released: false, error: String(error) }); failure ??= error; }
    try { await browser.close(); cleanup.push({ kind: 'edge', pid: evidence['pid'], released: evidence['exit_code'] === 0 && browserListenerReleased(), listener: evidence['listener'] }); }
    catch (error) { cleanup.push({ kind: 'edge', pid: evidence['pid'], released: false, error: String(error) }); failure ??= error; }
  }
  if (server.listening) {
    try {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      const released = await listenerReleased(webPort); cleanup.push({ kind: 'web', pid: process.pid, port: webPort, released });
      if (!released) failure ??= new Error('本轮前端端口未释放');
    } catch (error) { cleanup.push({ kind: 'web', port: webPort, released: false, error: String(error) }); failure ??= error; }
  }
  if (host) {
    try { await module.finishOwnHost(host); }
    catch (error) { cleanup.push({ kind: 'host_shutdown', error: String(error) }); failure ??= error; }
    const released = await listenerReleased(hostPort);
    const exited = host.child.exitCode !== null || host.child.signalCode !== null;
    cleanup.push({ kind: 'host', pid: host.child.pid, port: hostPort, released: released && exited, exit_code: host.child.exitCode, signal: host.child.signalCode });
    if (!released || !exited) failure ??= new Error('本轮宿主PID或端口未回收');
    if (host.child.exitCode !== 0) failure ??= new Error('本轮宿主没有正常退出');
  }
  if (browser && (evidence['exit_code'] !== 0 || !browserListenerReleased())) failure ??= new Error('本轮浏览器退出或端口释放未确认');
  if (!failure) {
    try { await rm(debuggerInside(output, profile), { recursive: true, force: true }); }
    catch (error) { cleanup.push({ kind: 'profile', released: false, error: String(error) }); failure ??= error; }
  }
  report['passed'] = report['business_passed'] === true && !failure;
  report['finished_at'] = new Date().toISOString();
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report['passed'], report: join(output, 'report.json'), cleanup }, null, 2));
}
if (failure) process.exitCode = 1;
