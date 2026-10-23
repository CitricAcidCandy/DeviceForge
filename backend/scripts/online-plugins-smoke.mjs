import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { browserFixture, deploymentSnapshot, failedFixtures, serverFixture, sha256 } from './online-plugins/fixtures.mjs';
import { smokeBinary } from './smoke-binaries.mjs';

// 仅使用已有宿主构建；夹具通过真正 HTTP 上传，不调用 Cargo/npm 或分发工具。
const backend = fileURLToPath(new URL('../', import.meta.url));
const arguments_ = process.argv.slice(2);
assert.ok(arguments_.every((value) => value === '--release'), '仅支持 --release 参数');
const profile = arguments_.includes('--release') ? 'release' : 'debug';
const suffix = process.platform === 'win32' ? '.exe' : '';
const binary = smokeBinary('apk-server', profile);
const reportPath = resolve(backend, '..', 'artifacts', `online-plugins-smoke-${profile}.json`);
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;
const report = { timestamp: new Date().toISOString(), profile, platform: process.platform, architecture: process.arch,
  scope: '本机默认免令牌真实 Rust HTTP/MCP、可信自包含 npm TGZ 在线部署、Node 协议 1/2 回显及浏览器静态 ESM/JSON 资源；未执行浏览器模块或 UI，不含隔离、真机、性能和分发验收',
  passed: false, default_without_token: false, server_packages: [], browser_package: {}, failed_packages: [] };
let temporary;
let plugins;
let browserPlugins;
let base;
let child;
let closed;
let spawnError;
let graceful = false;
let requestId = 0;
const taskSubmissions = [];
const logIds = [];
const headers = { 'content-type': 'application/json' };

async function poll(read, predicate, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(25);
  }
  throw new Error(`在线安装等待超时：${label}`);
}

async function reservePort() {
  const reservation = createServer();
  await new Promise((done, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', done);
  });
  const port = reservation.address().port;
  await new Promise((done, reject) => reservation.close((error) => error ? reject(error) : done()));
  return port;
}

async function call(path, options = {}) {
  const response = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(15000), ...options });
  const body = await response.json();
  const logId = response.headers.get('x-deviceforge-log-id');
  assert.match(logId, uuid, '真实 HTTP 响应必须带日志 ID');
  if (path.startsWith('/api/v2/')) assert.equal(body.log_id, logId);
  logIds.push(logId);
  report.last_request = { method: options.method ?? 'GET', path, status: response.status,
    log_id: logId, error_code: body.error?.code };
  return { response, body, logId };
}

async function rpc(method, params = {}) {
  const id = ++requestId;
  const reply = await call('/mcp', { method: 'POST',
    headers: { ...headers, accept: 'application/json, text/event-stream', origin: base },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  assert.equal(reply.response.status, 200);
  assert.equal(reply.body.id, id);
  assert.equal(reply.body.error ? reply.body.error.data.log_id
    : reply.body.result._meta['deviceforge/log_id'], reply.logId);
  return reply;
}

async function tool(name, arguments_ = {}, errorCode) {
  const reply = await rpc('tools/call', { name, arguments: arguments_ });
  assert.equal(reply.body.error, undefined);
  assert.equal(reply.body.result.isError, Boolean(errorCode));
  if (errorCode) assert.equal(reply.body.result.structuredContent.code, errorCode);
  return { ...reply, data: reply.body.result.structuredContent };
}

async function tools() {
  const names = [];
  let cursor;
  do {
    const reply = await rpc('tools/list', cursor ? { cursor } : {});
    assert.equal(reply.body.error, undefined);
    names.push(...reply.body.result.tools.map((item) => item.name));
    assert.ok(names.length <= 4200, '工具列表分页须有界');
    const next = reply.body.result.nextCursor;
    if (next) assert.notEqual(next, cursor, '工具分页游标须推进');
    cursor = next;
  } while (cursor);
  return names;
}

async function installed(kind) {
  const reply = await call(`/api/v2/plugin-packages/${kind}`);
  assert.equal(reply.response.status, 200);
  assert.ok(Array.isArray(reply.body.data));
  return reply.body.data;
}

async function upload(fixture) {
  return call(`/api/v2/plugin-packages/${fixture.kind}?format=tgz`, { method: 'POST',
    headers: { 'content-type': 'application/gzip' }, body: fixture.archive });
}

async function snapshot() {
  return { server: await deploymentSnapshot(plugins), browser: await deploymentSnapshot(browserPlugins) };
}

async function snapshotWhileCleaning() {
  try { return await snapshot(); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

async function settledSnapshot() {
  // 暂存守卫在阻塞池异步删除；有限等待清理收敛，不能把调度先后误判为残留。
  return poll(snapshotWhileCleaning, (value) => value && Object.values(value).every((entries) =>
    entries.every((entry) => !entry.path.split('/').some((part) => part.startsWith('.package-') || part.startsWith('.removed-')))),
  '部署暂存收敛', 5000);
}

async function assertUnchangedDeployment(before) {
  await poll(snapshotWhileCleaning, (value) => value && isDeepStrictEqual(value, before), '部署回滚无残留', 5000);
}

function assertPackage(info, fixture) {
  assert.equal(info.kind, fixture.kind);
  assert.equal(info.id, fixture.id);
  assert.equal(info.version, '1.0.0');
  assert.equal(info.runtime, fixture.kind === 'server' ? 'node' : 'browser');
  assert.equal(info.entry_path, fixture.kind === 'server' ? 'dist/index.mjs' : 'dist/index.js');
  assert.ok(Number.isSafeInteger(info.installed_at) && info.installed_at > 0);
  assert.equal(info.api_version, fixture.kind === 'browser' ? 2 : null);
  if (fixture.kind === 'server') assert.equal(info.entry_url, null);
  else assert.ok(typeof info.entry_url === 'string' && info.entry_url.startsWith(`/api/v2/browser-plugins/${fixture.id}/`));
}

async function finished(id) {
  return poll(async () => {
    const reply = await call(`/api/v2/jobs/${id}`);
    assert.equal(reply.response.status, 200);
    const value = reply.body.data;
    if (['failed', 'cancelled'].includes(value.status)) throw new Error(`在线回显任务失败：${value.status} ${value.error ?? ''}`);
    return value;
  }, (value) => value.status === 'succeeded', '在线插件任务');
}

async function assertUnavailable(operation) {
  const reply = await call('/api/v2/jobs', { method: 'POST',
    body: JSON.stringify({ operation, input: { message: '未加载', value: 0 } }) });
  assert.equal(reply.response.status, 404);
  assert.equal(reply.body.error.code, 'not_found');
  await tool(operation, { message: '未加载', value: 0 }, 'not_found');
  assert.ok(!(await tools()).includes(operation));
}

async function verifyFailedPackages() {
  for (const fixture of failedFixtures()) {
    const before = await settledSnapshot();
    const reply = await upload(fixture);
    const observed = { label: fixture.label, kind: fixture.kind, status: reply.response.status,
      error_code: reply.body.error?.code, log_id: reply.logId, rollback_no_residue: false };
    report.failed_packages.push(observed);
    assert.equal(reply.response.status, fixture.status ?? 400, `${fixture.label} 必须返回受控失败`);
    assert.equal(reply.body.error.code, fixture.errorCode ?? 'invalid_input');
    await assertUnchangedDeployment(before);
    assert.deepEqual(await installed('server'), []);
    assert.deepEqual(await installed('browser'), []);
    await assert.rejects(stat(join(temporary, 'ESCAPED_FILE')), { code: 'ENOENT' });
    observed.rollback_no_residue = true;
  }
}

async function verifyServer(fixture) {
  const observed = { id: fixture.id, protocol_version: fixture.protocol, passed: false };
  report.server_packages.push(observed);
  const operation = `plugin.${fixture.id}.echo`;
  const uploaded = await upload(fixture);
  observed.install_log_id = uploaded.logId;
  assert.equal(uploaded.response.status, 201);
  assertPackage(uploaded.body.data, fixture);
  assert.deepEqual(await installed('server'), [uploaded.body.data]);
  assert.deepEqual((await call('/api/v2/plugins')).body.data, []);
  assert.deepEqual((await tool('deviceforge.list_plugins')).data, []);
  await assertUnavailable(operation);
  const published = (await settledSnapshot()).server;
  assert.ok(!published.some((entry) => ['ENTRY_RAN', 'INSTALL_SCRIPT_RAN'].includes(entry.path.split('/').at(-1))),
    '安装不得运行包脚本或插件入口');
  observed.install_did_not_execute_code = true;

  const duplicateSnapshot = await settledSnapshot();
  const duplicate = await upload(fixture);
  assert.equal(duplicate.response.status, 409);
  assert.equal(duplicate.body.error.code, 'conflict');
  await assertUnchangedDeployment(duplicateSnapshot);
  observed.duplicate_install_rejected = true;
  const loaded = await call(`/api/v2/plugins/${fixture.id}/load`, { method: 'POST' });
  assert.equal(loaded.response.status, 200);
  assert.equal(loaded.body.data.state, 'loaded');
  assert.equal(loaded.body.data.cleanup_failed, false);
  observed.generation = loaded.body.data.generation;
  assert.ok((await tools()).includes(operation));
  const operationList = await call('/api/v2/operations');
  assert.equal(operationList.response.status, 200);
  assert.ok(operationList.body.data.some((entry) => entry.id === operation));

  const history = [];
  for (const transport of ['http', 'mcp']) {
    const input = { message: `协议 ${fixture.protocol} 在线包 ${transport} 回显`, value: 42 + fixture.protocol };
    const submitted = transport === 'http'
      ? await call('/api/v2/jobs', { method: 'POST', body: JSON.stringify({ operation, input }) })
      : await tool(operation, input);
    if (transport === 'http') assert.equal(submitted.response.status, 202);
    const task = transport === 'http' ? submitted.body.data : submitted.data;
    const completed = await finished(task.id);
    assert.deepEqual(completed.result, fixture.protocol === 1 ? input : { result: input, artifacts: [] });
    assert.equal((await tool('deviceforge.get_job', { id: task.id })).data.status, 'succeeded');
    history.push(task.id);
    taskSubmissions.push({ id: task.id, plugin_id: fixture.id, log_id: submitted.logId });
  }
  observed.http_mcp_completed_jobs = history;
  const afterExecution = await deploymentSnapshot(plugins);
  assert.ok(afterExecution.some((entry) => entry.path.endsWith('/ENTRY_RAN')), '真实 Node 入口必须执行');
  assert.ok(!afterExecution.some((entry) => entry.path.endsWith('/INSTALL_SCRIPT_RAN')));
  const protectedSnapshot = await settledSnapshot();
  const blocked = await call(`/api/v2/plugin-packages/server/${fixture.id}`, { method: 'DELETE' });
  assert.equal(blocked.response.status, 409);
  assert.equal(blocked.body.error.code, 'conflict');
  await assertUnchangedDeployment(protectedSnapshot);
  observed.loaded_delete_rejected = true;

  let unloaded;
  if (fixture.protocol === 1) unloaded = (await tool('deviceforge.unload_plugin', { id: fixture.id })).data;
  else {
    const reply = await call(`/api/v2/plugins/${fixture.id}/unload`, { method: 'POST' });
    assert.equal(reply.response.status, 200);
    unloaded = reply.body.data;
  }
  assert.equal(unloaded.state, 'unloaded');
  assert.equal(unloaded.cleanup_failed, false);
  assert.equal(unloaded.generation, loaded.body.data.generation);
  await assertUnavailable(operation);
  const deleted = await call(`/api/v2/plugin-packages/server/${fixture.id}`, { method: 'DELETE' });
  assert.equal(deleted.response.status, 200);
  assert.equal(deleted.body.data.id, fixture.id);
  assert.equal(deleted.body.data.kind, 'server');
  assert.deepEqual(await installed('server'), []);
  assert.ok(!(await deploymentSnapshot(plugins)).some((entry) => entry.path === fixture.id || entry.path.startsWith(`${fixture.id}/`)));
  const unavailable = await call(`/api/v2/plugins/${fixture.id}/load`, { method: 'POST' });
  assert.equal(unavailable.response.status, 404);
  assert.equal(unavailable.body.error.code, 'not_found');
  for (const id of history) {
    assert.equal((await finished(id)).status, 'succeeded');
    assert.equal((await tool('deviceforge.get_job', { id })).data.status, 'succeeded');
  }
  observed.deleted_after_unload = true;
  observed.history_preserved_after_delete = true;
  observed.passed = true;
}

async function asset(path, expected, mediaType) {
  const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(5000) });
  const logId = response.headers.get('x-deviceforge-log-id');
  assert.match(logId, uuid);
  logIds.push(logId);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', mediaType);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(bytes, expected, '成功静态资源必须保留原字节，不能套 v2 JSON 包装');
  const size = response.headers.get('content-length');
  if (size !== null) assert.equal(Number(size), expected.length);
  return { path, log_id: logId, content_type: response.headers.get('content-type'), bytes: bytes.length, sha256: sha256(bytes) };
}

async function verifyBrowser(fixture) {
  const observed = report.browser_package;
  observed.id = fixture.id;
  observed.passed = false;
  const uploaded = await upload(fixture);
  assert.equal(uploaded.response.status, 201);
  assertPackage(uploaded.body.data, fixture);
  assert.deepEqual(await installed('browser'), [uploaded.body.data]);
  observed.install_log_id = uploaded.logId;
  observed.entry_url = uploaded.body.data.entry_url;
  observed.api_version = uploaded.body.data.api_version;
  const prefix = `/api/v2/browser-plugins/${fixture.id}`;
  const runId = randomUUID();
  const moduleType = /^(?:text|application)\/javascript(?:;|$)/i;
  const jsonType = /^application\/json(?:;|$)/i;
  const relativeAsset = new URL('./settings.json', new URL(observed.entry_url, base));
  assert.equal(relativeAsset.origin, base, '模块相对资源必须属于本次宿主');
  observed.assets = [
    await asset(observed.entry_url, fixture.module, moduleType),
    await asset(`${relativeAsset.pathname}${relativeAsset.search}`, fixture.settings, jsonType),
    await asset(`${prefix}/assets/dist/index.js`, fixture.module, moduleType),
    await asset(`${prefix}/assets/dist/settings.json`, fixture.settings, jsonType),
    await asset(`${prefix}/runs/${runId}/assets/dist/index.js`, fixture.module, moduleType),
    await asset(`${prefix}/runs/${runId}/assets/dist/settings.json`, fixture.settings, jsonType),
  ];
  observed.static_module_bytes_preserved = true;
  observed.relative_json_bytes_preserved = true;
  observed.run_and_alias_paths_readable = true;
  observed.browser_module_executed = false;
  const before = await settledSnapshot();
  assert.ok(!before.browser.some((entry) => entry.path.endsWith('/INSTALL_SCRIPT_RAN')));
  const duplicate = await upload(fixture);
  assert.equal(duplicate.response.status, 409);
  assert.equal(duplicate.body.error.code, 'conflict');
  await assertUnchangedDeployment(before);
  assert.deepEqual(await installed('browser'), [uploaded.body.data]);
  observed.duplicate_install_rejected = true;
  const deleted = await call(`/api/v2/plugin-packages/browser/${fixture.id}`, { method: 'DELETE' });
  assert.equal(deleted.response.status, 200);
  assert.equal(deleted.body.data.id, fixture.id);
  assert.equal(deleted.body.data.kind, 'browser');
  assert.deepEqual(await installed('browser'), []);
  assert.ok(!(await deploymentSnapshot(browserPlugins)).some((entry) => entry.path === fixture.id || entry.path.startsWith(`${fixture.id}/`)));
  for (const path of [observed.entry_url, `${prefix}/assets/dist/settings.json`, `${prefix}/runs/${runId}/assets/dist/index.js`]) {
    const missing = await call(path);
    assert.equal(missing.response.status, 404);
    assert.equal(missing.body.error.code, 'not_found');
  }
  const repeated = await call(`/api/v2/plugin-packages/browser/${fixture.id}`, { method: 'DELETE' });
  assert.equal(repeated.response.status, 404);
  assert.equal(repeated.body.error.code, 'not_found');
  observed.deleted_assets_unavailable = true;
  observed.passed = true;
}

async function shutdown() {
  const response = await call('/api/v2/system/shutdown', { method: 'POST' });
  assert.equal(response.response.status, 200);
  assert.equal(response.body.data.stopping, true);
  report.shutdown_log_id = response.logId;
  let timer;
  try {
    const stopped = await Promise.race([closed, new Promise((done) => { timer = setTimeout(() => done({ timeout: true }), 10000); })]);
    assert.deepEqual(stopped, { code: 0, signal: null }, '无令牌关闭必须让自有宿主正常退出');
  } finally { clearTimeout(timer); }
  graceful = true;
  report.graceful_shutdown = true;
}

async function verifyLogs() {
  const directory = join(temporary, 'logs');
  const names = (await readdir(directory)).filter((name) => name.endsWith('.jsonl'));
  assert.ok(names.length > 0, '在线安装真实宿主日志须落盘');
  const logText = (await Promise.all(names.map((name) => readFile(join(directory, name), 'utf8')))).join('\n');
  const records = logText.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
  const correlated = (record, logId) => JSON.stringify(record).includes(logId);
  for (const logId of logIds) assert.ok(records.some((record) => correlated(record, logId)), '请求和静态资源日志 ID 须落盘');
  for (const task of taskSubmissions) {
    assert.ok(records.some((record) => record.fields?.message === '插件调用结束'
      && correlated(record, task.id) && correlated(record, task.log_id) && correlated(record, task.plugin_id)),
    '在线 Node 插件调用日志须关联提交请求、任务和插件');
  }
  assert.ok(records.some((record) => record.fields?.message === '宿主运行已结束'));
  report.persisted_log_records = records.length;
  report.correlated_response_log_ids = [...new Set(logIds)].length;
  report.task_and_request_log_correlation = true;
}

async function cleanup() {
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    try { await shutdown(); } catch {}
    if (child.exitCode === null && child.signalCode === null) child.kill();
    let timer;
    try {
      const stopped = await Promise.race([closed, new Promise((done) => { timer = setTimeout(() => done({ timeout: true }), 5000); })]);
      if (stopped.timeout) {
        report.temporary_retained = temporary;
        throw new Error('自有在线 smoke 宿主未退出，保留本次目录供主代理检查');
      }
    } finally { clearTimeout(timer); }
  }
  if (!temporary) return;
  const target = resolve(temporary);
  const within = relative(resolve(tmpdir()), target);
  if (!within || within.startsWith('..') || isAbsolute(within)) throw new Error('在线 smoke 清理路径越界');
  await rm(target, { recursive: true, force: true });
  report.temporary_removed = true;
}

try {
  assert.ok((await stat(binary)).isFile(), `缺少当前 ${profile} apk-server，请由主代理统一构建`);
  temporary = await mkdtemp(join(tmpdir(), 'deviceforge-online-plugins-'));
  plugins = join(temporary, 'server-plugins');
  browserPlugins = join(temporary, 'browser-plugins');
  await mkdir(plugins);
  await mkdir(browserPlugins);
  const port = await reservePort();
  base = `http://127.0.0.1:${port}`;
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(APK_|DEVICEFORGE_)/.test(key)));
  child = spawn(binary, [], { cwd: backend, windowsHide: true, stdio: 'ignore',
    env: { ...environment, APK_BIND: `127.0.0.1:${port}`, APK_DATA_DIR: temporary,
      APK_PLUGIN_DIR: plugins, APK_BROWSER_PLUGIN_DIR: browserPlugins, DEVICEFORGE_USER_DIR: join(temporary, 'user', '.deviceforge'),
      DEVICEFORGE_NODE: process.execPath, DEVICEFORGE_HTTP_RATE: '10000',
      APK_MCP_HOSTS: `127.0.0.1:${port}`, APK_MCP_ORIGINS: base } });
  child.on('error', (error) => { spawnError = error; });
  closed = new Promise((done) => child.once('close', (code, signal) => done({ code, signal })));
  await poll(async () => {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('在线 smoke 宿主在就绪前退出');
    try { return (await call('/api/v2/health')).response.ok; } catch { return false; }
  }, Boolean, '默认无令牌真实服务就绪');
  report.default_without_token = true;
  report.server_pid = child.pid;
  report.node_runtime = { version: process.versions.node, source: '管理员 DEVICEFORGE_NODE=process.execPath' };
  assert.deepEqual(await installed('server'), []);
  assert.deepEqual(await installed('browser'), []);
  assert.deepEqual((await call('/api/v2/plugins')).body.data, []);
  await verifyFailedPackages();
  for (const protocol of [1, 2]) await verifyServer(serverFixture(protocol));
  await verifyBrowser(browserFixture());
  assert.equal(child.exitCode, null);
  assert.equal(child.pid, report.server_pid, '在线安装与删除不得重启宿主');
  report.server_restarted = false;
  await shutdown();
  await verifyLogs();
  report.passed = true;
} catch (error) {
  report.error = String(error.message).slice(0, 2000);
  report.error_location = String(error.stack).split('\n').find((line) => line.includes('online-plugins-smoke.mjs'))?.trim();
  report.failed_request = report.last_request;
  process.exitCode = 1;
} finally {
  try { await cleanup(); }
  catch (error) { report.cleanup_error = String(error.message).slice(0, 1000); report.passed = false; process.exitCode = 1; }
  report.graceful_shutdown = graceful;
  report.completed_at = new Date().toISOString();
  await mkdir(resolve(backend, '..', 'artifacts'), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
}
