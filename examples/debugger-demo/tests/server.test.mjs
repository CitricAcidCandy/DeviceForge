import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Readable, PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { readRequest, respond } from '../server/protocol.mjs';

const entry = fileURLToPath(new URL('../server/entry.mjs', import.meta.url));
const request = (input = { message: '你好😀' }) => ({ protocol_version: 1, request_id: 'demo-1', operation: 'echo', input });

function run(input, context) {
  // 同步运行自有协议入口并确认退出；不启动宿主、工具、设备或后台服务。
  const child = spawnSync(process.execPath, [entry], { input, encoding: 'utf8', timeout: 5000,
    maxBuffer: 131072, windowsHide: true });
  context.diagnostic(`进程回收：PID=${child.pid}，命令=node server/entry.mjs，退出码=${child.status}，信号=${child.signal ?? '无'}`);
  assert.ifError(child.error);
  assert.equal(child.signal, null);
  assert.throws(() => process.kill(child.pid, 0), (error) => error.code === 'ESRCH');
  return child;
}

test('纯协议保留请求身份，Unicode 按字符上限校验', () => {
  assert.deepEqual(respond(request()), { protocol_version: 1, request_id: 'demo-1', result: { message: '你好😀', source: 'demo_debugger_server' } });
  assert.ok(respond(request({ message: '😀'.repeat(1000) })).result);
  for (const input of [null, [], {}, { message: 1 }, { message: 'x', extra: 1 }, { message: '😀'.repeat(1001) }]) {
    const response = respond(request(input));
    assert.equal(response.request_id, 'demo-1');
    assert.equal(typeof response.error, 'string');
    assert.equal(response.result, undefined);
  }
  assert.ok(respond({ ...request(), operation: 'unknown' }).error);
  for (const input of [null, [], { ...request(), protocol_version: 2 }, { ...request(), request_id: '' }])
    assert.throws(() => respond(input));
});

test('读取器拒绝超限、非法 UTF-8、坏 JSON，并在期限后释放监听', async () => {
  await assert.rejects(readRequest(Readable.from([Buffer.alloc(65537)])), /超过限额/);
  await assert.rejects(readRequest(Readable.from([Buffer.from([0xff])])), /UTF-8 JSON/);
  await assert.rejects(readRequest(Readable.from([Buffer.from('{')])), /UTF-8 JSON/);
  const stalled = new PassThrough();
  await assert.rejects(readRequest(stalled, { timeoutMs: 15 }), /读取失败/);
  assert.equal(stalled.listenerCount('data'), 0);
  assert.equal(stalled.listenerCount('end'), 0);
  assert.equal(stalled.listenerCount('error'), 0);
  stalled.destroy();
});

test('真实 Node 入口只输出一条协议结果且零退出', (context) => {
  const child = run(JSON.stringify(request()), context);
  assert.equal(child.status, 0);
  assert.equal(child.stderr, '');
  assert.equal(child.stdout.trim().split('\n').length, 1);
  assert.deepEqual(JSON.parse(child.stdout), respond(request()));
});

test('已识别的业务拒绝返回同请求 ID，不回显非法输入', (context) => {
  const child = run(JSON.stringify(request({ message: 'x', secret: 'synthetic-sentinel' })), context);
  assert.equal(child.status, 0);
  assert.equal(child.stderr, '');
  const response = JSON.parse(child.stdout);
  assert.equal(response.request_id, 'demo-1');
  assert.ok(response.error);
  assert.ok(!child.stdout.includes('synthetic-sentinel'));
});

test('无法匹配身份、坏 JSON 和超限均无 stdout，非零退出且固定诊断', (context) => {
  for (const input of [JSON.stringify({ ...request(), request_id: '' }), '{', 'x'.repeat(65537)]) {
    const child = run(input, context);
    assert.equal(child.status, 1);
    assert.equal(child.stdout, '');
    assert.equal(child.stderr, '独立回显请求读取或身份校验失败\n');
  }
});
