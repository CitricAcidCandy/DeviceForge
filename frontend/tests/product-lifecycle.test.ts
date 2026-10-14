import assert from 'node:assert/strict';
import test from 'node:test';
import { createMediaControlQueue } from '../src/app/product/media-controls.ts';
import { probeProductConnection, productServiceOrigin } from '../src/app/product/connection.ts';
import { createProductServices } from '../src/app/product/services.ts';
import { withSelectedDevice } from '../src/app/product/device-target.ts';
import { ApiError } from '../src/shared/api/index.ts';
import type { MirroringControl } from '../src/features/mirroring-streaming/index.ts';
import { directory, provider } from './device-fixtures.ts';
import { deferred, failure, requestUrl, signal, success } from './fixtures.ts';

test('服务切换只允许HTTP原点，新连接探测保留日志且不泄漏令牌到URL', async () => {
  assert.equal(productServiceOrigin(' http://192.168.1.20:7031/ '), 'http://192.168.1.20:7031');
  for (const value of ['file:///tmp', 'http://user:secret@example.com', 'http://example.com/a', 'http://example.com/?token=secret', 'http://example.com/#secret']) assert.throws(() => productServiceOrigin(value));
  let requested = false;
  const result = await probeProductConnection('http://localhost:7031', 'test-session-token', async (input, init) => {
    requested = true; assert.equal(requestUrl(input).pathname, '/api/v2/operations');
    assert.equal(requestUrl(input).search, ''); assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-session-token');
    return success([], 'connection-log');
  }, signal());
  assert.ok(requested); assert.equal(result.logId, 'connection-log');
});

test('新连接失败或取消不进入产品装配，也不自动重试请求', async () => {
  let calls = 0;
  await assert.rejects(probeProductConnection('http://localhost:7031', '', async () => {calls += 1; return failure('unauthorized', 401);}, signal()), error => error instanceof ApiError && error.logId === 'log-error');
  assert.equal(calls, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(probeProductConnection('http://localhost:7031', '', async () => {calls += 1; return success([]);}, controller.signal));
  assert.equal(calls, 1);
});

test('媒体输入按下、合并移动和释放保持顺序，不被后续事件取消', async () => {
  const received: MirroringControl[] = []; const first = deferred<void>(); const finished = deferred<void>();
  const queue = createMediaControlQueue({identity: () => 'session:1', send: async value => {
    received.push(value); if (received.length === 1) await first.promise;
    if (value.type === 'touch' && value.action === 'up') finished.resolve();
  }, failed: error => {throw error;}});
  const touch = (action: 'down' | 'move' | 'up', x: number): MirroringControl => ({type: 'touch', action, x, y: 1, width: 100, height: 100, pointer_id: 1});
  queue.enqueue([touch('down', 1)]); queue.enqueue([touch('move', 2)]); queue.enqueue([touch('move', 3)]); queue.enqueue([touch('up', 3)]);
  assert.equal(received.length, 1); first.resolve(); await finished.promise;
  assert.deepEqual(received, [touch('down', 1), touch('move', 3), touch('up', 3)]); queue.dispose();
});

test('媒体连接代次变化撤销排队键盘释放，关闭后不再派发', async () => {
  let identity = 'session:1'; const gate = deferred<void>(); const received: MirroringControl[] = [];
  const queue = createMediaControlQueue({identity: () => identity, send: async value => {received.push(value); await gate.promise;}, failed: error => {throw error;}});
  queue.enqueue([{type: 'key', action: 'down', keycode: 3}, {type: 'key', action: 'up', keycode: 3}]);
  identity = 'session:2'; gate.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(received.length, 1); queue.dispose(); queue.enqueue([{type: 'rotate'}]);
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(received.length, 1);
});

test('完整设备引用切换拒绝旧独立插件晚到结果，保留已收到日志', async () => {
  const services = createProductServices({baseUrl: 'http://localhost:7031', panelTarget: () => null, transport: async input => {
    return requestUrl(input).pathname.endsWith('device-providers') ? success([provider('first'), provider('second')]) : success([directory('first'), directory('second')]);
  }});
  try {
    await services.runtime.devices.refreshDirectories(signal());
    services.runtime.devices.select({providerId: 'first', generation: 'g1', localId: 'same'});
    const gate = deferred<{logId: string}>(); const observed = deferred<AbortSignal>();
    const waiting = withSelectedDevice(services, signal(), async (reference, current) => {assert.equal(reference.providerId, 'first'); observed.resolve(current); return gate.promise;});
    services.runtime.devices.select({providerId: 'second', generation: 'g1', localId: 'same'});
    gate.resolve({logId: 'late-device-log'});
    await assert.rejects(waiting, error => error instanceof ApiError && error.code === 'stale_device_result' && error.logId === 'late-device-log');
    assert.equal((await observed.promise).aborted, true);
  } finally {await services.dispose();}
});
