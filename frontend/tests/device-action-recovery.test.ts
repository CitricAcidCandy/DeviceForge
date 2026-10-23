import assert from 'node:assert/strict';
import test from 'node:test';
import { createDevices } from '../src/features/devices/index.ts';
import type { DeviceGateway } from '../src/features/devices/index.ts';
import { HostError } from '../src/plugin-sdk/index.ts';
import type { DeviceAction, DeviceDirectory, DeviceProviderInfo } from '../src/plugin-sdk/index.ts';
import { deferred, signal } from './fixtures.ts';

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
    beforeDiscovery: (() => Promise<void>) | null;
    providerReads: number; directoryReads: number; actions: number; discoveries: number;
  } = {
    generation: 'g1', observed: true, observedAt: 1, actionError: original, readError: null,
    beforeReject: null, beforeProviderRead: null, beforeDiscovery: null,
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

test('动作冲突后只读重查新代，撤销旧引用，保留原错误且不重放动作', async (t) => {
  const { devices, remote, original } = await fixture();
  t.after(() => devices.dispose());
  remote.generation = 'g2';
  remote.observed = false;
  await assert.rejects(devices.invoke(action, signal()), (error: unknown) => error === original);
  assert.equal(devices.snapshot().providers[0]?.generation, 'g2');
  assert.equal(devices.snapshot().selection, null);
  assert.deepEqual(devices.snapshot().directories, []);
  await assert.rejects(devices.invoke(action, signal()), (error: unknown) => error instanceof HostError && error.code === 'conflict');
  assert.equal(remote.actions, 1);
  assert.equal(remote.discoveries, 0);
  assert.equal(remote.providerReads, 2);
  assert.equal(remote.directoryReads, 2);
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
