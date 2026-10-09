import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

const temporary = await mkdtemp(join(tmpdir(), 'deviceforge-logging-'));
const reservation = createServer();
await new Promise((done) => reservation.listen(0, '127.0.0.1', done));
const port = reservation.address().port;
await new Promise((done) => reservation.close(done));
const base = `http://127.0.0.1:${port}`;
const suffix = process.platform === 'win32' ? '.exe' : '';
const profile = process.argv.includes('--release') ? 'release' : 'debug';
const token = randomBytes(32).toString('hex');
const sentinel = `privacy-sentinel-${randomBytes(16).toString('hex')}`;
const directory = join(temporary, 'plugins', 'echo');
await mkdir(directory, { recursive: true });
await writeFile(join(directory, 'manifest.json'), JSON.stringify({
  id: 'echo', version: '0.1.0', protocol_version: 1,
  executable: resolve(`target/${profile}`, `deviceforge-echo-plugin${suffix}`), args: [],
  operations: [{ name: 'echo', title: '回显', input_schema: { type: 'object' } }],
}));
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(APK_|DEVICEFORGE_)/.test(key)));
const child = spawn(resolve(`target/${profile}`, `apk-server${suffix}`), [], {
  env: { ...environment, APK_API_TOKEN: token, APK_BIND: `127.0.0.1:${port}`, APK_DATA_DIR: temporary,
    APK_PLUGIN_DIR: join(temporary, 'plugins'), DEVICEFORGE_HTTP_RATE: '100000', DEVICEFORGE_LOG_QUEUE: '8192' },
  stdio: 'ignore', windowsHide: true,
});
let spawnError;
child.on('error', (error) => { spawnError = error; });
const closed = new Promise((done) => child.once('close', (code) => done(code)));
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
async function call(path, options = {}) {
  const response = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(5000), ...options });
  const body = await response.json();
  const id = response.headers.get('x-deviceforge-log-id');
  assert.match(id, /^[\da-f-]{36}$/);
  if (path.startsWith('/api/v2/') && !path.endsWith('openapi.json')) assert.equal(body.log_id, id);
  return { response, body, id };
}
async function load(path, total = 2000, concurrency = 32) {
  let cursor = 0; const times = [];
  const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor++ < total) {
      const before = performance.now();
      const { response } = await call(path);
      assert.equal(response.status, 200);
      times.push(performance.now() - before);
    }
  }));
  const elapsed = performance.now() - started;
  times.sort((a, b) => a - b);
  return { path, requests: total, concurrency, elapsed_ms: elapsed, requests_per_second: total * 1000 / elapsed,
    p50_ms: times[Math.floor(total * 0.5)], p95_ms: times[Math.floor(total * 0.95)], p99_ms: times[Math.floor(total * 0.99)] };
}
let graceful = false;
try {
  let ready = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error('日志服务在就绪前退出');
    try { ready = (await call('/api/v2/health')).response.ok; } catch {}
    if (ready) break;
    await delay(50);
  }
  assert.ok(ready);
  const rejected = await call('/api/v2/health', { headers: { authorization: `Bearer ${sentinel}` } });
  assert.equal(rejected.response.status, 401);
  const missing = await call(`/api/v2/jobs/${encodeURIComponent(sentinel)}`);
  assert.equal(missing.response.status, 404);
  const submitted = await call('/api/v2/jobs', { method: 'POST', body: JSON.stringify({ operation: 'plugin.echo.echo', input: { message: sentinel } }) });
  assert.equal(submitted.response.status, 202);
  const jobId = submitted.body.data.id;
  let finished = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    const status = (await call(`/api/v2/jobs/${jobId}`)).body.data;
    if (status.status === 'succeeded') { assert.equal(status.result.message, sentinel); finished = true; break; }
    assert.notEqual(status.status, 'failed');
    await delay(10);
  }
  assert.ok(finished);
  // MCP 成功、协议失败和传输拒绝各走真实 SDK 路径。
  for (const [method, params, error] of [
    ['initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: sentinel, version: '1' } }, false],
    ['tools/list', {}, false], ['ping', {}, false], ['missing', {}, true],
  ]) {
    const reply = await call('/mcp', { method: 'POST', headers: { ...headers, accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    assert.equal(error ? reply.body.error.data.log_id : reply.body.result._meta['deviceforge/log_id'], reply.id);
  }
  const transport = await call('/mcp', { method: 'POST',
    headers: { ...headers, accept: 'application/json, text/event-stream', origin: 'http://untrusted.invalid' }, body: '{}' });
  assert.equal(transport.response.status, 403);
  assert.equal(transport.body.log_id, transport.id);
  assert.equal(transport.body.error.code, 'mcp_transport_rejected');
  const loads = [await load('/api/v2/health'), await load('/api/v2/jobs?limit=1')];
  const stats = (await call('/api/v2/diagnostics/logging')).body.data;
  assert.equal(stats.write_errors, 0);
  assert.equal(stats.oversized_records, 0);
  assert.ok(stats.written_bytes > 0);
  const stopping = await call('/api/v2/system/shutdown', { method: 'POST' });
  assert.equal(stopping.body.data.stopping, true);
  const exit = await Promise.race([closed, delay(10000).then(() => 'timeout')]);
  assert.equal(exit, 0);
  graceful = true;
  const names = (await readdir(join(temporary, 'logs'))).filter((name) => name.endsWith('.jsonl'));
  assert.ok(names.length > 0);
  const text = (await Promise.all(names.map((name) => readFile(join(temporary, 'logs', name), 'utf8')))).join('');
  assert.ok(!text.includes(token));
  assert.ok(!text.includes(sentinel));
  const records = text.trim().split('\n').map((line) => JSON.parse(line));
  const pluginEvent = records.find((record) => record.fields?.message === '插件调用结束');
  assert.ok(pluginEvent);
  assert.ok(JSON.stringify(pluginEvent).includes(submitted.id));
  assert.ok(JSON.stringify(pluginEvent).includes(jobId));
  assert.ok(pluginEvent.span?.plugin_request_id);
  assert.ok(records.some((record) => record.fields?.message === '宿主运行已结束'));
  assert.ok(records.some((record) => record.fields?.message === '响应流已结束' && JSON.stringify(record).includes(stopping.id)));
  const report = { timestamp: new Date().toISOString(), profile, platform: process.platform, architecture: process.arch,
    scope: '本机回环；32 并发；真实服务和 SQLite；开启 INFO 日志；测试请求限流 100000/s；不含真机、慢磁盘或远端客户端',
    loads, log_stats_before_shutdown: stats, persisted_records: records.length, persisted_bytes: Buffer.byteLength(text),
    correlation_and_sensitive_data_checks: '通过', graceful_shutdown: true };
  await mkdir(resolve('../artifacts'), { recursive: true });
  await writeFile(resolve(`../artifacts/logging-smoke-${profile}.json`), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (!graceful && child.exitCode === null) { child.kill(); await closed; }
  const target = resolve(temporary); const within = relative(resolve(tmpdir()), target);
  if (!within || within.startsWith('..') || isAbsolute(within)) throw new Error('日志测试清理路径越界');
  await rm(target, { recursive: true, force: true });
}
