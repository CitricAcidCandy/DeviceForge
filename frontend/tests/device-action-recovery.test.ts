import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeviceGateway } from '../src/app/device-gateway.ts';
import { createDevices } from '../src/features/devices/index.ts';
import type { DeviceGateway } from '../src/features/devices/index.ts';
import { HostError } from '../src/plugin-sdk/index.ts';
import type { DeviceAction, DeviceDirectory, DeviceProviderInfo } from '../src/plugin-sdk/index.ts';
import { createApiClient } from '../src/services/api/index.ts';
import { directory as directoryDto, provider as providerDto } from './device-fixtures.ts';
import { deferred, requestUrl, signal, success } from './fixtures.ts';

function provider(generation = 'g1'): DeviceProviderInfo {
  return {
    id: 'example', generation, version: '1.0',
    definition: {
      apiVersion: 1, platform: '模拟平台', discoverOperation: 'example.discover',
      capabilities: [{ id: 'read', version: 1, operation: 'example.read', scope: 'device', access: 'read' }],
    },
  };
}
function directory(generation = 'g1', observedAt = 1): DeviceDirectory {
  return {
    provider: provider(generation), observedAt, discoveryJobId: 'observed',
    devices: [{
      reference: { providerId: 'example', generation, localId: 'same' },
      state: 'online', model: null,
      capabilities: [{ id: 'read', version: 1, available: true, reason: null }],
    }],
  };
}
const action: DeviceAction = {
  providerId: 'example', generation: 'g1', deviceId: 'same',
  capability: 'read', version: 1, input: {},
};

async function fixture() {
  const original = new HostError('protocol', 'conflict', '原始设备冲突', 'original-log', 409);
  const remote: {
    generation: string; observed: boolean; observedAt: number;
    actionError: unknown; readError: unknown;
    beforeReject: (() => Promise<void>) | null;
    beforeProviderRead: (() => Promise<void>) | null;
    beforeDirectoryRead: (() => Promise<void>) | null;
    beforeDiscovery: (() => Promise<void>) | null;
    providerReads: number; directoryReads: number; actions: number; discoveries: number;
  } = {
    generation: 'g1', observed: true, observedAt: 1, actionError: original, readError: null,
    beforeReject: null, beforeProviderRead: null, beforeDirectoryRead: null, beforeDiscovery: null,
    providerReads: 0, directoryReads: 0, actions: 0, discoveries: 0,
  };
  const gateway: DeviceGateway = {
    async refreshProviders() {
      ++remote.providerReads;
      await remote.beforeProviderRead?.();
      if (remote.readError) throw remote.readError;
      return { data: [provider(remote.generation)], logId: 'providers-log' };
    },
    async refreshDirectories() {
      ++remote.directoryReads;
      await remote.beforeDirectoryRead?.();
      return { data: remote.observed ? [directory(remote.generation, remote.observedAt)] : [], logId: 'directories-log' };
    },
    async refreshProvider() {
      ++remote.discoveries;
      await remote.beforeDiscovery?.();
      return { data: directory(remote.generation, remote.observedAt), logId: 'discovery-log' };
    },
    async invoke() {
      ++remote.actions;
      await remote.beforeReject?.();
      if (remote.actionError) throw remote.actionError;
      return { data: { id: 'accepted', operation: 'example.read', status: 'queued', result: null, error: null }, logId: 'action-log' };
    },
  };
  const devices = createDevices(gateway);
  await devices.refreshDirectories(signal());
  devices.select({ providerId: 'example', generation: 'g1', localId: 'same' });
  return { devices, remote, original };
}

async function httpFixture() {
  const remote = { generation: 'g1', observed: true, code: 'conflict', status: 409 };
  const requests: string[] = [];
  const client = createApiClient({
    baseUrl: 'http://device-recovery.invalid',
    transport: async (input, init) => {
      const path = requestUrl(input).pathname;
      requests.push(`${init?.method} ${path}`);
      if (path === '/api/v2/device-providers')
        return success([providerDto('example', remote.generation)], 'providers-log');
      if (path === '/api/v2/devices')
        return success(remote.observed ? [directoryDto('example', remote.generation)] : [], 'directories-log');
      assert.equal(path, '/api/v2/device-actions');
      assert.equal(init?.method, 'POST');
      return Response.json(
        { log_id: 'http-conflict-log', error: { code: remote.code, message: '原始 HTTP 设备错误' } },
        {
          status: remote.status,
          headers: { 'x-deviceforge-log-id': 'http-conflict-log', 'retry-after': '2' },
        },
      );
    },
  });
  const devices = createDevices(createDeviceGateway(client, signal()));
  await devices.refreshDirectories(signal());
  devices.select({ providerId: 'example', generation: 'g1', localId: 'same' });
  return { devices, remote, requests };
}

test('真实客户端和公开网关的 HTTP 409 保留类别与日志，仅 GET 重查目录', async (t) => {
  const { devices, remote, requests } = await httpFixture();
  t.after(() => devices.dispose());
  remote.generation = 'g2';
  remote.observed = false;
  await assert.rejects(devices.invoke(action, signal()), (error: unknown) => {
    assert.ok(error instanceof HostError);
    assert.equal(error.kind, 'http');
    assert.equal(error.code, 'conflict');
    assert.equal(error.status, 409);
    assert.equal(error.message, '原始 HTTP 设备错误');
    assert.equal(error.logId, 'http-conflict-log');
    assert.equal(error.retryAfter, '2');
    return true;
  });
  assert.equal(devices.snapshot().providers[0]?.generation, 'g2');
  assert.equal(devices.snapshot().selection, null);
  assert.deepEqual(devices.snapshot().directories, []);
  assert.deepEqual(requests, [
    'GET /api/v2/device-providers', 'GET /api/v2/devices',
    'POST /api/v2/device-actions',
    'GET /api/v2/device-providers', 'GET /api/v2/devices',
  ]);
});

test('真实 HTTP 忙碌冲突不能清掉仍有效的目录或自动重放动作', async (t) => {
  const { devices, requests } = await httpFixture();
  t.after(() => devices.dispose());
  await assert.rejects(devices.invoke(action, signal()), (error: unknown) =>
    error instanceof HostError && error.kind === 'http' && error.code === 'conflict');
  assert.equal(devices.snapshot().selection?.generation, 'g1');
  assert.equal(devices.snapshot().directories.length, 1);
  assert.equal(requests.filter((request) => request.startsWith('POST ')).length, 1);
  assert.equal(requests.filter((request) => request.startsWith('GET ')).length, 4);
});

test('本地旧代校验冲突也重查目录，但绝不向服务端提交旧动作', async (t) => {
  const { devices, remote } = await fixture();
  t.after(() => devices.dispose());
  remote.generation = 'g2';
  await devices.refreshProviders(signal());
  remote.observed = false;
  await assert.rejects(devices.invoke(action, signal()), (error: unknown) =>
    error instanceof HostError && error.kind === 'protocol' &&
    error.code === 'conflict' && error.status === 409);
  assert.equal(remote.actions, 0);
  assert.equal(remote.discoveries, 0);
  assert.equal(remote.providerReads, 3);
  assert.equal(remote.directoryReads, 2);
  assert.deepEqual(devices.snapshot().directories, []);
});

test('本地缺失观测目录可以只读恢复，恢复成功也不替用户提交动作', async (t) => {
  const { devices, remote } = await fixture();
  t.after(() => devices.dispose());
  remote.observed = false;
  await devices.refreshDirectories(signal());
  remote.observed = true;
  await assert.rejects(devices.invoke(action, signal()), (error: unknown) =>
    error instanceof HostError && error.code === 'conflict' && error.logId === null);
  assert.equal(devices.snapshot().directories.length, 1);
  assert.equal(devices.snapshot().selection, null);
  assert.equal(remote.actions, 0);
  assert.equal(remote.discoveries, 0);
});

test('非法参数与未声明能力不触发恢复或设备动作', async (t) => {
  const { devices, remote } = await fixture();
  t.after(() => devices.dispose());
  for (const invalid of [
    { ...action, version: 0 },
    { ...action, deviceId: null },
    { ...action, input: { invalid: NaN } },
    { ...action, capability: 'undeclared' },
  ]) {
    await assert.rejects(devices.invoke(invalid, signal()), (error: unknown) =>
      error instanceof HostError && (error.code === 'invalid_input' || error.code === 'not_found'));
  }
  assert.equal(remote.providerReads, 1);
  assert.equal(remote.directoryReads, 1);
  assert.equal(remote.actions, 0);
  assert.equal(remote.discoveries, 0);
});

test('真实 HTTP 非 conflict/409 错误不误触发只读恢复', async (t) => {
  const { devices, remote, requests } = await httpFixture();
  t.after(() => devices.dispose());
  for (const [code, status] of [
    ['cleanup_failed', 409], ['invalid_input', 400], ['dependency_failed', 502], ['conflict', 400],
  ] satisfies [string, number][]) {
    remote.code = code;
    remote.status = status;
    await assert.rejects(devices.invoke(action, signal()), (error: unknown) =>
      error instanceof HostError && error.kind === 'http' && error.code === code &&
      error.status === status && error.logId === 'http-conflict-log');
  }
  assert.equal(requests.filter((request) => request.startsWith('GET ')).length, 2);
  assert.equal(requests.filter((request) => request.startsWith('POST ')).length, 4);
  assert.equal(devices.snapshot().selection?.generation, 'g1');
});

test('显式聚合目录重查正在等待时，冲突不能使其结果过期', async (t) => {
  const { devices, remote, original } = await fixture();
  t.after(() => devices.dispose());
  const started = deferred<void>();
  const response = deferred<void>();
  remote.beforeDirectoryRead = () => { started.resolve(); return response.promise; };
  const explicit = assert.doesNotReject(devices.refreshDirectories(signal()));
  await started.promise;
  await assert.rejects(devices.invoke(action, signal()), (error: unknown) => error === original);
  remote.observedAt = 2;
  response.resolve();
  await explicit;
  assert.equal(devices.snapshot().directories[0]?.observedAt, 2);
  assert.equal(remote.providerReads, 2);
  assert.equal(remote.directoryReads, 2);
  assert.equal(remote.actions, 1);
});

test('恢复读取目录时后启动的显式聚合刷新优先', async (t) => {
  const { devices, remote, original } = await fixture();
  t.after(() => devices.dispose());
  const started = deferred<void>();
  const response = deferred<void>();
  remote.beforeDirectoryRead = () => { started.resolve(); return response.promise; };
  const rejected = assert.rejects(devices.invoke(action, signal()), (error: unknown) => error === original);
  await started.promise;
  remote.beforeDirectoryRead = null;
  remote.observedAt = 2;
  await devices.refreshDirectories(signal());
  await rejected;
  response.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(devices.snapshot().directories[0]?.observedAt, 2);
  assert.equal(remote.providerReads, 3);
  assert.equal(remote.directoryReads, 3);
  assert.equal(remote.actions, 1);
});

test('恢复忽略取消且永不返回时，固定五秒预算结束等待并保留原错误', { timeout: 2000 }, async (t) => {
  const { devices, remote, original } = await fixture();
  t.after(() => devices.dispose());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const started = deferred<void>();
  remote.beforeProviderRead = () => { started.resolve(); return new Promise<void>(() => {}); };
  const rejected = assert.rejects(devices.invoke(action, signal()), (error: unknown) => error === original);
  await started.promise;
  t.mock.timers.tick(5000);
  await rejected;
  assert.equal(original.logId, 'original-log');
  assert.deepEqual(devices.snapshot().directories, []);
  remote.beforeProviderRead = null;
  await devices.refreshDirectories(signal());
  assert.equal(devices.snapshot().directories.length, 1);
  assert.equal(remote.actions, 1);
});

test('两步目录重查共用五秒预算，超时后的迟到设备目录不写回', { timeout: 2000 }, async (t) => {
  const { devices, remote, original } = await fixture();
  t.after(() => devices.dispose());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const listing = deferred<void>();
  const listed = deferred<void>();
  const reading = deferred<void>();
  const response = deferred<void>();
  remote.beforeProviderRead = () => { listing.resolve(); return listed.promise; };
  remote.beforeDirectoryRead = () => { reading.resolve(); return response.promise; };
  const rejected = assert.rejects(devices.invoke(action, signal()), (error: unknown) => error === original);
  await listing.promise;
  t.mock.timers.tick(4000);
  listed.resolve();
  await reading.promise;
  t.mock.timers.tick(1000);
  await rejected;
  assert.deepEqual(devices.snapshot().directories, []);
  remote.observedAt = 99;
  response.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(devices.snapshot().directories, []);
  assert.equal(remote.actions, 1);
  assert.equal(remote.discoveries, 0);
});

test('恢复途中调用者取消后原错误仍可见，迟到重查不能更新目录', async (t) => {
  const { devices, remote, original } = await fixture();
  t.after(() => devices.dispose());
  const controller = new AbortController();
  const started = deferred<void>();
  const response = deferred<void>();
  remote.beforeProviderRead = () => { started.resolve(); return response.promise; };
  const rejected = assert.rejects(devices.invoke(action, controller.signal), (error: unknown) => error === original);
  await started.promise;
  controller.abort();
  await rejected;
  remote.generation = 'g2';
  response.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(devices.snapshot().providers[0]?.generation, 'g1');
  assert.equal(remote.directoryReads, 1);
  assert.equal(remote.actions, 1);
});

test('恢复途中销毁目录结束等待，不继续查询设备或覆盖原错误', async (t) => {
  const { devices, remote, original } = await fixture();
  t.after(() => devices.dispose());
  const started = deferred<void>();
  const response = deferred<void>();
  remote.beforeProviderRead = () => { started.resolve(); return response.promise; };
  const rejected = assert.rejects(devices.invoke(action, signal()), (error: unknown) => error === original);
  await started.promise;
  devices.dispose();
  await rejected;
  response.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(remote.directoryReads, 1);
  assert.equal(remote.actions, 1);
});

test('动作冲突后只读重查新代，撤销旧引用，保留原错误且不重放动作', async (t) => {
  const { devices, remote, original } = await fixture();
  t.after(() => devices.dispose());
  remote.generation = 'g2';
  remote.observed = false;
  await assert.rejects(devices.invoke(action, signal()), (error: unknown) => error === original);
  assert.equal(devices.snapshot().providers[0]?.generation, 'g2');
  assert.equal(devices.snapshot().selection, null);
  assert.deepEqual(devices.snapshot().directories, []);
  assert.equal(remote.providerReads, 2);
  assert.equal(remote.directoryReads, 2);
  await assert.rejects(devices.invoke(action, signal()), (error: unknown) => error instanceof HostError && error.code === 'conflict');
  assert.equal(remote.actions, 1);
  assert.equal(remote.discoveries, 0);
  assert.equal(remote.providerReads, 3);
  assert.equal(remote.directoryReads, 3);
});

test('同代目录已撤销时清除旧观测和选择，重新发现后由用户重新提交', async (t) => {
  const { devices, remote, original } = await fixture();
  t.after(() => devices.dispose());
  remote.observed = false;
  await assert.rejects(devices.invoke(action, signal()), (error: unknown) => error === original);
  assert.equal(devices.snapshot().selection, null);
  assert.deepEqual(devices.snapshot().directories, []);
  await assert.rejects(devices.invoke(action, signal()));
  assert.equal(remote.actions, 1);
  await devices.refreshProvider('example', 'g1', signal());
  devices.select({ providerId: 'example', generation: 'g1', localId: 'same' });
  remote.actionError = null;
  assert.equal((await devices.invoke(action, signal())).data.id, 'accepted');
  assert.equal(remote.actions, 2);
});

test('忙碌冲突但目录未变时保留有效选择，不自动发现或重放', async (t) => {
  const { devices, remote, original } = await fixture();
  t.after(() => devices.dispose());
  await assert.rejects(devices.invoke(action, signal()), (error: unknown) => error === original);
  assert.equal(devices.snapshot().selection?.generation, 'g1');
  assert.equal(devices.snapshot().directories.length, 1);
  assert.equal(remote.actions, 1);
  assert.equal(remote.discoveries, 0);
  assert.equal(remote.providerReads, 2);
});

test('重查失败不覆盖原错误与日志，仅撤销失败动作的旧观测', async (t) => {
  const { devices, remote, original } = await fixture();
  t.after(() => devices.dispose());
  remote.readError = new HostError('network', 'network_error', '重查网络不可用');
  await assert.rejects(devices.invoke(action, signal()), (error: unknown) => error === original);
  assert.equal(original.logId, 'original-log');
  assert.equal(devices.snapshot().selection, null);
  assert.deepEqual(devices.snapshot().directories, []);
  assert.equal(remote.actions, 1);
  assert.equal(remote.directoryReads, 1);
});

test('旧动作迟到冲突不撤销已经显式刷新的新观测', async (t) => {
  const { devices, remote, original } = await fixture();
  t.after(() => devices.dispose());
  const started = deferred<void>();
  const response = deferred<void>();
  remote.beforeReject = () => {
    started.resolve();
    return response.promise;
  };
  const waiting = devices.invoke(action, signal());
  await started.promise;
  remote.observedAt = 2;
  await devices.refreshDirectories(signal());
  const reads = remote.providerReads;
  response.resolve();
  await assert.rejects(waiting, (error: unknown) => error === original);
  assert.equal(devices.snapshot().directories[0]?.observedAt, 2);
  assert.equal(devices.snapshot().selection?.generation, 'g1');
  assert.equal(remote.providerReads, reads);
});

test('清理保护或其他失败不能触发冲突恢复，更不能清除保护', async (t) => {
  const { devices, remote } = await fixture();
  t.after(() => devices.dispose());
  for (const error of [
    new HostError('protocol', 'cleanup_failed', '插件资源清理未确认', 'cleanup-log', 409),
    new HostError('protocol', 'dependency_failed', '依赖不可用', 'dependency-log', 502),
  ]) {
    remote.actionError = error;
    await assert.rejects(devices.invoke(action, signal()), (value: unknown) => value === error);
  }
  assert.equal(remote.providerReads, 1);
  assert.equal(remote.directoryReads, 1);
  assert.equal(devices.snapshot().selection?.generation, 'g1');
});

test('成功或调用者已取消时不发起额外目录请求', async (t) => {
  const { devices, remote } = await fixture();
  t.after(() => devices.dispose());
  remote.actionError = null;
  await devices.invoke(action, signal());
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(devices.invoke(action, controller.signal));
  assert.equal(remote.actions, 1);
  assert.equal(remote.providerReads, 1);
  assert.equal(remote.directoryReads, 1);
});

test('恢复等待期间新发起的显式发现优先，不把旧缓存写回', async (t) => {
  const { devices, remote, original } = await fixture();
  t.after(() => devices.dispose());
  const reading = deferred<void>();
  const listed = deferred<void>();
  const discovering = deferred<void>();
  const discovered = deferred<void>();
  remote.beforeProviderRead = () => { reading.resolve(); return listed.promise; };
  remote.beforeDiscovery = () => { discovering.resolve(); return discovered.promise; };
  const rejected = assert.rejects(devices.invoke(action, signal()), (error: unknown) => error === original);
  await reading.promise;
  const explicit = devices.refreshProvider('example', 'g1', signal());
  await discovering.promise;
  listed.resolve();
  await rejected;
  assert.deepEqual(devices.snapshot().directories, []);
  assert.equal(remote.directoryReads, 1);
  remote.observedAt = 2;
  discovered.resolve();
  await explicit;
  assert.equal(devices.snapshot().directories[0]?.observedAt, 2);
});

test('已有提供者列表请求时也撤销冲突旧目录，不打断该请求', async (t) => {
  const { devices, remote, original } = await fixture();
  t.after(() => devices.dispose());
  const reading = deferred<void>();
  const listed = deferred<void>();
  remote.beforeProviderRead = () => { reading.resolve(); return listed.promise; };
  const explicit = devices.refreshProviders(signal());
  await reading.promise;
  await assert.rejects(devices.invoke(action, signal()), (error: unknown) => error === original);
  assert.equal(devices.snapshot().selection, null);
  assert.deepEqual(devices.snapshot().directories, []);
  listed.resolve();
  await explicit;
  assert.deepEqual(devices.snapshot().directories, []);
  assert.equal(remote.providerReads, 2);
  assert.equal(remote.directoryReads, 1);
});
