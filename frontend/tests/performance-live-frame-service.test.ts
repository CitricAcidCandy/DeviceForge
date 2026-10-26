import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createProductServices } from '../src/app/product/services.ts';
import { ApiError } from '../src/services/api/index.ts';
import { captureLiveFrame, liveFrameCapability } from '../src/pages/performance/services/live-frames.ts';
import { directory } from './device-fixtures.ts';
import { deferred, requestUrl, success } from './fixtures.ts';

const reference = { providerId: 'android-device', generation: 'g1', localId: 'phone' };
const operation = 'plugin.android-device.screenshot';
const bytes = Buffer.from('截图原始字节');
function fixture(mode: 'normal' | 'hash' | 'pending' | 'poll-error' | 'cancel-error' | 'cancel-pending' | 'submit-error' | 'submit-pending' = 'normal') {
  const base = directory(reference.providerId, reference.generation, [reference.localId]);
  const provider = {
    ...base.provider,
    definition: { ...base.provider.definition, capabilities: [{
      id: 'screenshot', version: 1, operation, scope: 'device' as const, access: 'write' as const,
    }] },
  };
  const observed = {
    ...base, provider,
    devices: base.devices.map((device) => ({ ...device, capabilities: [{
      id: 'screenshot', version: 1, available: true, reason: null,
    }] })),
  };
  const pending = deferred<Response>();
  const requests: string[] = [];
  let body: unknown = null;
  let cancelling = false;
  const artifact = {
    id: '11111111-1111-4111-8111-111111111111', filename: 'screenshot.png',
    media_type: 'image/png', size: bytes.length, created_at: 17000,
    sha256: mode === 'hash' ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex'),
  };
  const job = (status: 'running' | 'succeeded' | 'cancelled') => ({
    id: 'shot-1', operation, input: {}, created_at: 1000, status, error: null,
    result: status === 'succeeded' ? { result: null, artifacts: [artifact] } : null,
  });
  const services = createProductServices({
    baseUrl: 'http://localhost:7031', panelTarget: () => null,
    transport: async (input, init) => {
      const path = requestUrl(input).pathname;
      requests.push(path);
      if (path.endsWith('/operations')) return success([{ id: operation, title: '截图', input_schema: { type: 'object' } }]);
      if (path.endsWith('/device-providers')) return success([provider]);
      if (path.endsWith('/devices')) return success([observed]);
      if (path.endsWith('/device-actions')) {
        body = JSON.parse(String(init?.body));
        if (mode === 'submit-error') throw new TypeError('网络中断');
        if (mode === 'submit-pending') return pending.promise;
        return success(job(['normal', 'hash'].includes(mode) ? 'succeeded' : 'running'), 'capture-log');
      }
      if (path.endsWith('/jobs/shot-1/cancel')) {
        cancelling = true;
        if (mode === 'cancel-error') throw new TypeError('取消网络中断');
        return success(job(mode === 'cancel-pending' ? 'running' : 'cancelled'), 'cancel-log');
      }
      if (path.endsWith('/jobs/shot-1')) {
        if (mode === 'cancel-pending' && cancelling) return success(job('cancelled'), 'confirmed-log');
        if (['poll-error', 'cancel-error', 'cancel-pending'].includes(mode)) throw new TypeError('轮询网络中断');
        return pending.promise;
      }
      if (path.includes('/artifacts/'))
        return new Response(bytes, { headers: { 'content-type': 'image/png', 'x-deviceforge-log-id': 'download-log' } });
      throw new Error('未预期请求：' + path);
    },
  });
  return {
    services, pending, requests, body: () => body,
    setMode(next: typeof mode) { mode = next; },
    async prepare() {
      const signal = new AbortController().signal;
      await services.runtime.operations.refresh(signal);
      await services.runtime.devices.refreshDirectories(signal);
      await services.runtime.devices.select(reference);
    },
  };
}

test('截图适配只走公开设备能力，核验产物原字节并返回服务器时间', async () => {
  const f = fixture();
  try {
    await f.prepare();
    assert.ok(liveFrameCapability(f.services, reference).capability);
    const result = await captureLiveFrame(f.services, reference, new AbortController().signal);
    assert.equal(result.publishedAt, 17000);
    assert.ok(result.durationMs >= 0);
    assert.equal(await result.content.text(), bytes.toString());
    assert.deepEqual(f.body(), {
      provider_id: reference.providerId, generation: reference.generation,
      device_id: reference.localId, capability: 'screenshot', version: 1, input: {},
    });
    assert.equal(f.requests.filter((path) => path.endsWith('/device-actions')).length, 1);
  } finally { await f.services.dispose(); }
});

test('未选中来源时禁止截图，不因为其他在线设备具备能力而回退', async () => {
  const f = fixture();
  try {
    await f.prepare();
    await f.services.runtime.devices.select(null);
    assert.equal(liveFrameCapability(f.services, reference).capability, null);
    await assert.rejects(captureLiveFrame(f.services, reference, new AbortController().signal), /会话来源不同/);
    assert.equal(f.requests.filter((path) => path.endsWith('/device-actions')).length, 0);
  } finally { await f.services.dispose(); }
});

test('截图摘要不符时拒绝显示，保留实际下载日志ID', async () => {
  const f = fixture('hash');
  try {
    await f.prepare();
    await assert.rejects(captureLiveFrame(f.services, reference, new AbortController().signal), (error: unknown) => {
      assert.ok(error instanceof Error && 'code' in error && 'logId' in error);
      assert.equal(error.code, 'artifact_digest_mismatch');
      assert.equal(error.logId, 'download-log');
      return true;
    });
  } finally { await f.services.dispose(); }
});

test('局域网HTTP无WebCrypto时仍核验截图SHA256，不降级跳过校验', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis.crypto, 'subtle');
  Object.defineProperty(globalThis.crypto, 'subtle', { configurable: true, value: undefined });
  const f = fixture();
  const damaged = fixture('hash');
  try {
    await f.prepare();
    assert.equal((await captureLiveFrame(f.services, reference, new AbortController().signal)).content.size, bytes.length);
    await damaged.prepare();
    await assert.rejects(captureLiveFrame(damaged.services, reference, new AbortController().signal), /摘要/);
  } finally {
    await f.services.dispose();
    await damaged.services.dispose();
    if (descriptor) Object.defineProperty(globalThis.crypto, 'subtle', descriptor);
    else Reflect.deleteProperty(globalThis.crypto, 'subtle');
  }
});

test('切换设备撤销在途等待并请求取消已知截图任务，不自动重交', async () => {
  const f = fixture('pending');
  try {
    await f.prepare();
    const capture = captureLiveFrame(f.services, reference, new AbortController().signal);
    const rejected = assert.rejects(capture);
    for (let index = 0; index < 100 && !f.requests.some((path) => path.endsWith('/jobs/shot-1')); index++)
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    assert.ok(f.requests.some((path) => path.endsWith('/jobs/shot-1')));
    await f.services.runtime.devices.select(null);
    await rejected;
    assert.equal(f.requests.filter((path) => path.endsWith('/jobs/shot-1/cancel')).length, 1);
    assert.equal(f.requests.filter((path) => path.endsWith('/device-actions')).length, 1);
  } finally {
    f.pending.resolve(success(null));
    await f.services.dispose();
  }
});

test('查询网络失败也取消已知任务，并在取消仍运行时确认终态', async () => {
  for (const mode of ['poll-error', 'cancel-pending'] as const) {
    const f = fixture(mode);
    try {
      await f.prepare();
      await assert.rejects(captureLiveFrame(f.services, reference, new AbortController().signal));
      assert.equal(f.requests.filter((path) => path.endsWith('/jobs/shot-1/cancel')).length, 1);
      assert.equal(f.requests.filter((path) => path.endsWith('/jobs/shot-1')).length, mode === 'cancel-pending' ? 2 : 1);
      assert.equal(f.requests.filter((path) => path.endsWith('/device-actions')).length, 1);
    } finally { await f.services.dispose(); }
  }
});

test('取消或提交未确认保留真实错误与任务身份，不自动重交但允许显式重新调用', async () => {
  for (const mode of ['cancel-error', 'submit-error'] as const) {
    const f = fixture(mode);
    try {
      await f.prepare();
      await assert.rejects(captureLiveFrame(f.services, reference, new AbortController().signal), (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, mode === 'cancel-error' ? 'frame_cancel_unconfirmed' : 'frame_submission_unconfirmed');
        assert.match(error.message, /手动重试/);
        assert.doesNotMatch(error.message, /阻止本会话再次提交/);
        if (mode === 'cancel-error') {
          assert.match(error.message, /shot-1/);
          assert.match(error.message, /无法取得服务器响应/);
          assert.equal(error.logId, 'capture-log');
        } else {
          assert.match(error.message, /任务 ID 未取得/);
          assert.match(error.message, /无法取得服务器响应/);
        }
        return true;
      });
      assert.equal(f.requests.filter((path) => path.endsWith('/device-actions')).length, 1);
      f.setMode('normal');
      const result = await captureLiveFrame(f.services, reference, new AbortController().signal);
      assert.equal(await result.content.text(), bytes.toString());
      assert.equal(f.requests.filter((path) => path.endsWith('/device-actions')).length, 2);
      assert.equal(f.requests.filter((path) => path.endsWith('/jobs/shot-1/cancel')).length, mode === 'cancel-error' ? 1 : 0);
    } finally { await f.services.dispose(); }
  }
});

test('提交在途撤销且任务ID尚未知时仍报告结果不确定，不静默当作取消成功', async () => {
  const f = fixture('submit-pending');
  const controller = new AbortController();
  try {
    await f.prepare();
    const capture = captureLiveFrame(f.services, reference, controller.signal);
    const rejected = assert.rejects(capture, (error: unknown) => {
      assert.ok(error instanceof Error && 'code' in error);
      assert.equal(error.code, 'frame_submission_unconfirmed');
      assert.match(error.message, /任务 ID 未取得/);
      assert.match(error.message, /手动重试/);
      return true;
    });
    while (!f.body()) await new Promise<void>((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await rejected;
    assert.equal(f.requests.filter((path) => path.endsWith('/device-actions')).length, 1);
  } finally { f.pending.resolve(success(null)); await f.services.dispose(); }
});
