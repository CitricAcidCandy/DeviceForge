import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { smokeBinary } from './smoke-binaries.mjs';

const temporary = await mkdtemp(join(tmpdir(), 'deviceforge-lifecycle-'));
const plugins = join(temporary, 'plugins');
await mkdir(plugins);
const reservation = createServer();
await new Promise((done) => reservation.listen(0, '127.0.0.1', done));
const port = reservation.address().port;
await new Promise((done) => reservation.close(done));
const base = `http://127.0.0.1:${port}`;
const profile = process.argv.includes('--release') ? 'release' : 'debug';
const suffix = process.platform === 'win32' ? '.exe' : '';
const token = randomBytes(32).toString('hex');
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(APK_|DEVICEFORGE_)/.test(key)));
const child = spawn(smokeBinary('apk-server', profile), [], {
  env: { ...environment, APK_API_TOKEN: token, APK_BIND: `127.0.0.1:${port}`,
    APK_DATA_DIR: temporary, APK_PLUGIN_DIR: plugins, DEVICEFORGE_USER_DIR: join(temporary, 'user', '.deviceforge'), DEVICEFORGE_HTTP_RATE: '10000' },
  stdio: 'ignore', windowsHide: true,
});
let spawnError;
child.on('error', (error) => { spawnError = error; });
const closed = new Promise((done) => child.once('close', (code) => done(code)));
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const managementLogs = [];
async function call(path, options = {}) {
  const response = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(15000), ...options });
  const body = await response.json();
  const id = response.headers.get('x-deviceforge-log-id');
  assert.match(id, /^[\da-f-]{36}$/);
  if (path.startsWith('/api/v2/')) assert.equal(body.log_id, id);
  return { response, body, id };
}
async function rpc(method, params = {}) {
  const reply = await call('/mcp', { method: 'POST',
    headers: { ...headers, accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  assert.equal(reply.response.status, 200);
  assert.equal(reply.body.error ? reply.body.error.data.log_id : reply.body.result._meta['deviceforge/log_id'], reply.id);
  return reply;
}
async function manage(id, action, transport = 'http') {
  if (transport === 'http') {
    const reply = await call(`/api/v2/plugins/${id}/${action}`, { method: 'POST' });
    assert.equal(reply.response.status, 200);
    managementLogs.push(reply.id);
    return reply.body.data;
  }
  const reply = await rpc('tools/call', { name: `deviceforge.${action}_plugin`, arguments: { id } });
  assert.equal(reply.body.result.isError, false);
  managementLogs.push(reply.id);
  return reply.body.result.structuredContent;
}
async function deploy(id, executable, args, operations) {
  const directory = join(plugins, id);
  await mkdir(directory);
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ id, version: '1.0.0',
    protocol_version: 1, executable, args, operations }));
}
const operation = (name) => ({ name, title: '生命周期验证', input_schema: { type: 'object' } });
async function submit(operation, input) {
  const reply = await call('/api/v2/jobs', { method: 'POST', body: JSON.stringify({ operation, input }) });
  assert.equal(reply.response.status, 202);
  return reply.body.data;
}
async function poll(read, predicate, label) {
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(25);
  }
  throw new Error(`等待超时：${label}`);
}
async function job(id) { return (await call(`/api/v2/jobs/${id}`)).body.data; }
let graceful = false;
try {
  await poll(async () => {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error('服务就绪前退出');
    try { return (await call('/api/v2/health')).response.ok; } catch { return false; }
  }, Boolean, '空插件服务启动');
  const serverPid = child.pid;
  assert.deepEqual((await call('/api/v2/plugins')).body.data, []);
  assert.equal((await call('/api/v2/plugins', { headers: {} })).response.status, 401);
  assert.equal((await call('/api/v2/plugins/missing/load', { method: 'POST' })).response.status, 404);
  assert.equal((await call('/api/v2/plugins/builtin.adb/load', { method: 'POST' })).response.status, 400);
  const echo = smokeBinary('deviceforge-echo-plugin', profile);
  // 服务已经启动，之后才部署与加载；无需重启宿主。
  await deploy('echo', echo, [], [operation('echo')]);
  const first = await manage('echo', 'load');
  assert.equal(first.state, 'loaded');
  assert.equal((await call('/api/v2/plugins/echo/load', { method: 'POST' })).response.status, 409);
  const submitted = await submit('plugin.echo.echo', { message: '运行中加载' });
  const finished = await poll(() => job(submitted.id), (value) => value.status === 'succeeded', '原生回显');
  assert.equal(finished.result.message, '运行中加载');
  const detached = await manage('echo', 'unload', 'mcp');
  assert.equal(detached.state, 'unloaded');
  assert.equal(detached.generation, first.generation);
  assert.ok(!(await rpc('tools/list')).body.result.tools.some((tool) => tool.name === 'plugin.echo.echo'));
  assert.equal((await call('/api/v2/jobs', { method: 'POST', body: JSON.stringify({ operation: 'plugin.echo.echo', input: {} }) })).response.status, 404);
  assert.equal((await job(submitted.id)).status, 'succeeded');
  const second = await manage('echo', 'load', 'mcp');
  assert.notEqual(second.generation, first.generation);
  assert.ok((await rpc('tools/list')).body.result.tools.some((tool) => tool.name === 'plugin.echo.echo'));
  const markers = join(temporary, 'markers');
  await mkdir(markers);
  const slow = join(temporary, 'slow.mjs');
  await writeFile(slow, `import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
// 只写测试部署指定的进程标记，不派生后台进程。
const request = JSON.parse(readFileSync(0,'utf8'));
writeFileSync(join(process.argv[2],String(request.input.slot)),String(process.pid));
setTimeout(() => process.stdout.write(JSON.stringify({protocol_version:1,request_id:request.request_id,result:{}})),20000);
`);
  await deploy('slow', process.execPath, [slow, markers], [operation('wait')]);
  await manage('slow', 'load');
  const pending = [];
  for (let slot = 0; slot < 5; slot++) pending.push(await submit('plugin.slow.wait', { slot }));
  const pids = await poll(async () => {
    const names = await readdir(markers);
    if (names.length !== 4) return [];
    return Promise.all(names.map(async (name) => Number(await readFile(join(markers, name), 'utf8'))));
  }, (value) => value.length === 4 && value.every((pid) => Number.isInteger(pid) && pid > 0), '四个独立插件进程运行');
  const before = await Promise.all(pending.map((item) => job(item.id)));
  assert.equal(before.filter((value) => value.status === 'running').length, 4);
  assert.equal(before.filter((value) => value.status === 'queued').length, 1);
  const healthStarted = performance.now();
  assert.equal((await call('/api/v2/health')).response.status, 200);
  const healthMs = performance.now() - healthStarted;
  assert.ok(healthMs < 2000, '插件等待期间异步健康入口仍应可用');
  const unloadStarted = performance.now();
  await manage('slow', 'unload');
  const unloadMs = performance.now() - unloadStarted;
  for (const item of pending) assert.equal((await job(item.id)).status, 'cancelled');
  for (const pid of pids) {
    assert.throws(() => process.kill(pid, 0), (error) => error.code === 'ESRCH', '卸载返回后独立插件进程应退出');
  }
  assert.equal((await readdir(markers)).length, 4, '排队任务不得启动第五个进程');
  const many = Array.from({ length: 105 }, (_, index) => operation(`echo_${index}`));
  await deploy('many', echo, [], many);
  await manage('many', 'load');
  const page = (await rpc('tools/list')).body.result;
  assert.equal(page.tools.length, 100);
  assert.ok(page.nextCursor);
  await manage('many', 'unload', 'mcp');
  const expired = await rpc('tools/list', { cursor: page.nextCursor });
  assert.equal(expired.body.error.code, -32602);
  await deploy('broken', echo, [], [operation('echo')]);
  await writeFile(join(plugins, 'broken', 'manifest.json'), '{');
  assert.equal((await call('/api/v2/plugins/broken/load', { method: 'POST' })).response.status, 400);
  const listed = (await call('/api/v2/plugins')).body.data;
  assert.deepEqual(listed.map((item) => item.id), ['echo']);
  assert.equal(listed[0].generation, second.generation);
  const mcpListed = (await rpc('tools/call', { name: 'deviceforge.list_plugins', arguments: {} })).body.result;
  assert.deepEqual(mcpListed.structuredContent, listed);
  assert.equal(child.pid, serverPid);
  assert.equal(child.exitCode, null);
  assert.equal((await job(submitted.id)).status, 'succeeded');
  assert.equal((await call('/api/v2/system/shutdown', { method: 'POST' })).response.status, 200);
  assert.equal(await Promise.race([closed, delay(10000).then(() => 'timeout')]), 0);
  graceful = true;
  const names = (await readdir(join(temporary, 'logs'))).filter((name) => name.endsWith('.jsonl'));
  const logText = (await Promise.all(names.map((name) => readFile(join(temporary, 'logs', name), 'utf8')))).join('');
  assert.ok(!logText.includes(token));
  const records = logText.trim().split('\n').map((line) => JSON.parse(line));
  for (const logId of managementLogs) {
    for (const message of ['插件生命周期变更开始', '插件生命周期变更结束']) {
      assert.ok(records.some((record) => record.fields?.message === message && JSON.stringify(record).includes(logId)), '管理工作须保留请求日志关联');
    }
  }
  assert.ok(records.some((record) => record.fields?.message === '宿主运行已结束'));
  const report = { timestamp: new Date().toISOString(), profile, platform: process.platform, architecture: process.arch,
    scope: '本机真实 HTTP/MCP 与原生回显/Node 独立进程；空插件启动后部署；不含常驻插件、设备适配器和真机',
    server_restarted: false, generation_changed: true, completed_job_retained: true,
    cancelled_running_processes: pids.length, cancelled_queued_jobs: 1, unload_ms: unloadMs,
    health_during_plugin_wait_ms: healthMs, stale_mcp_cursor_rejected: true,
    authentication_and_manifest_rejections: '通过', lifecycle_log_correlation: '通过', graceful_shutdown: true };
  await mkdir(resolve('../artifacts'), { recursive: true });
  await writeFile(resolve(`../artifacts/plugin-lifecycle-smoke-${profile}.json`), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  // 失败先保留任务和进程标记，避免清理后只能看到排队超时。
  const diagnostic = {
    timestamp: new Date().toISOString(),
    profile,
    passed: false,
    error: error.stack,
    temporary,
  };
  for (const [name, path] of [
    ['jobs', '/api/v2/jobs?limit=100'],
    ['plugins', '/api/v2/plugins'],
  ]) {
    try {
      diagnostic[name] = (await call(path)).body.data;
    } catch (failure) {
      diagnostic[`${name}_error`] = failure.message;
    }
  }
  try {
    diagnostic.markers = await readdir(join(temporary, 'markers'));
  } catch {
    diagnostic.markers = [];
  }
  await mkdir(resolve('../artifacts'), { recursive: true });
  const location = resolve(
    `../artifacts/plugin-lifecycle-smoke-failure-${profile}-${Date.now()}.json`,
  );
  await writeFile(location, `${JSON.stringify(diagnostic, null, 2)}\n`);
  console.error(`生命周期失败证据：${location}`);
  throw error;
} finally {
  if (!graceful && child.exitCode === null) { child.kill(); await closed; }
  const target = resolve(temporary); const within = relative(resolve(tmpdir()), target);
  if (!within || within.startsWith('..') || isAbsolute(within)) throw new Error('插件生命周期测试清理路径越界');
  if (graceful) await rm(target, { recursive: true, force: true });
}
