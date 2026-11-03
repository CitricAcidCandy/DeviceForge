import assert from 'node:assert/strict';
import test from 'node:test';
import createDevicesPlugin, { DEVICES_PLUGIN_ID } from '../plugins/devices/src/index.ts';
import { startInitialDirectoryRead } from '../plugins/devices/src/initial-directory.ts';
import { createDevices } from '../src/features/devices/models/devices.ts';
import type { DeviceGateway } from '../src/features/devices/models/devices.ts';
import { createWorkspaceRegistry } from '../src/plugins/workspace/index.ts';
import { HostError } from '../src/plugin-sdk/index.ts';
import type { DebugEventInput, DeviceAccess, DeviceProviderInfo, Dispose, HostContext, HostResult } from '../src/plugin-sdk/index.ts';
import { deferred } from './fixtures.ts';

const provider: DeviceProviderInfo = {
  id: 'example_device', version: '1.0.0', generation: 'current',
  definition: { apiVersion: 3, platform: '自定义平台', discoverOperation: 'example.discover', capabilities: [] },
};
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture(devices: DeviceAccess) {
  const controller = new AbortController(), releases: Dispose[] = [], events: DebugEventInput[] = [];
  const context: HostContext = {
    apiVersion: 2, signal: controller.signal, devices,
    listOperations: async () => { throw new Error('不得读取业务操作'); },
    submit: async () => { throw new Error('不得提交设备动作'); },
    getJob: async () => { throw new Error('不得查询设备任务'); },
    cancelJob: async () => { throw new Error('不得取消设备任务'); },
    subscribeOperations: () => () => {},
    onDispose: (release) => { releases.push(release); return release; },
    debug: {
      emit: (event) => { events.push(event); },
      registerNode: () => { throw new Error('初始化不登记界面节点'); },
      registerResource: (_definition, release) => release,
    },
  };
  return { context, events, controller, async dispose() {
    controller.abort();
    for (const release of releases.reverse()) await release();
  } };
}
function gateway(read: DeviceGateway['refreshProviders']) {
  const calls = { providers: 0, directories: 0, discoveries: 0, actions: 0 };
  return {
    calls,
    value: {
      refreshProviders: (signal) => { calls.providers++; return read(signal); },
      refreshDirectories: async () => { calls.directories++; return { data: [], logId: 'directory-log' }; },
      refreshProvider: async () => { calls.discoveries++; throw new Error('不得自动发现'); },
      invoke: async () => { calls.actions++; throw new Error('不得自动操作设备'); },
    } satisfies DeviceGateway,
  };
}

test('空目录只读初始化已开始时页面仍完成登记，慢读取不阻塞激活且不自动发现', { timeout: 1500 }, async () => {
  const pending = deferred<HostResult<readonly DeviceProviderInfo[]>>();
  const source = gateway(() => pending.promise), devices = createDevices(source.value), current = fixture(devices);
  const registry = createWorkspaceRegistry();
  const ui = registry.access({ pluginId: DEVICES_PLUGIN_ID, generation: 1, signal: current.context.signal });
  try {
    const plugin = createDevicesPlugin({ id: DEVICES_PLUGIN_ID, version: '0.1.0', apiVersion: 2 });
    await plugin.activate?.({ ...current.context, ui });
    assert.equal(ui.catalog().pages[0]?.route, '/devices');
    assert.equal(source.calls.providers, 1);
    assert.equal(source.calls.directories, 0, '未取得提供者前不串发聚合目录');
    pending.resolve({ data: [provider], logId: 'provider-log' });
    await turn();
    assert.equal(source.calls.directories, 1);
    assert.deepEqual(devices.snapshot().providers, [provider]);
    assert.equal(source.calls.discoveries, 0);
    assert.equal(source.calls.actions, 0);
  } finally { await current.dispose(); devices.dispose(); registry.dispose(); }
});

test('已有提供者观测时不发重复初始化读取，不变更当前选择', async () => {
  const source = gateway(async () => ({ data: [provider], logId: 'provider-log' }));
  const devices = createDevices(source.value), current = fixture(devices);
  try {
    await devices.refreshProviders(new AbortController().signal);
    const before = devices.snapshot();
    const dispose = startInitialDirectoryRead(current.context);
    await turn();
    assert.deepEqual(source.calls, { providers: 1, directories: 0, discoveries: 0, actions: 0 });
    assert.deepEqual(devices.snapshot(), before);
    await dispose();
  } finally { await current.dispose(); devices.dispose(); }
});

test('首次目录读取失败保留日志诊断，后续手动新读取仍可成功且不自动重试', async () => {
  const source = gateway(async () => {
    if (source.calls.providers === 1) throw new HostError('http', 'directory_failed', '目录读取失败', 'original-log');
    return { data: [provider], logId: 'new-log' };
  });
  const devices = createDevices(source.value), current = fixture(devices);
  try {
    const dispose = startInitialDirectoryRead(current.context);
    await turn();
    assert.equal(source.calls.providers, 1);
    assert.equal(current.events.length, 1);
    assert.equal(current.events[0]?.metadata?.logId, 'original-log');
    await devices.refreshDirectories(new AbortController().signal);
    assert.deepEqual(devices.snapshot().providers, [provider]);
    assert.equal(current.events.length, 1, '新成功不抹掉原失败');
    assert.deepEqual(source.calls, { providers: 2, directories: 1, discoveries: 0, actions: 0 });
    await dispose();
  } finally { await current.dispose(); devices.dispose(); }
});

test('卸载只取消本次初始化信号，忽略取消的旧结果不污染后续手动目录', async () => {
  const pending = deferred<HostResult<readonly DeviceProviderInfo[]>>();
  const seen: AbortSignal[] = [];
  const source = gateway(async (signal) => {
    seen.push(signal);
    if (source.calls.providers === 1) return pending.promise;
    return { data: [provider], logId: 'new-log' };
  });
  const devices = createDevices(source.value), current = fixture(devices);
  try {
    const release = startInitialDirectoryRead(current.context);
    assert.equal(source.calls.providers, 1);
    await current.dispose();
    assert.equal(seen[0]?.aborted, true);
    await devices.refreshDirectories(new AbortController().signal);
    await release();
    assert.equal(seen[1]?.aborted, false, '晚到旧清理不得取消手动读取');
    pending.resolve({ data: [], logId: 'late-log' });
    await turn();
    assert.deepEqual(devices.snapshot().providers, [provider]);
    assert.equal(current.events.length, 0, '撤销后不发布旧诊断');
    assert.deepEqual(source.calls, { providers: 2, directories: 1, discoveries: 0, actions: 0 });
  } finally { pending.resolve({ data: [], logId: 'cleanup-log' }); await current.dispose(); devices.dispose(); }
});

test('初始化等待有界，期限后不自动重试且下一次独立读取不受旧等待影响', async () => {
  const pending = deferred<HostResult<readonly DeviceProviderInfo[]>>();
  const source = gateway(() => source.calls.providers === 1 ? pending.promise : Promise.resolve({ data: [provider], logId: 'new-log' }));
  const devices = createDevices(source.value), current = fixture(devices);
  try {
    const release = startInitialDirectoryRead(current.context, 8);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(source.calls.providers, 1);
    assert.equal(current.events[0]?.metadata?.code, 'initial_directory_timeout');
    await devices.refreshDirectories(new AbortController().signal);
    await release();
    assert.deepEqual(devices.snapshot().providers, [provider]);
    assert.equal(source.calls.discoveries, 0);
    assert.equal(source.calls.actions, 0);
  } finally { pending.resolve({ data: [], logId: 'late-log' }); await current.dispose(); devices.dispose(); }
});

test('手动读取接管在途初始化，旧取消不发布失败或撤销新读取', async () => {
  const initial = deferred<HostResult<readonly DeviceProviderInfo[]>>();
  const manual = deferred<HostResult<readonly DeviceProviderInfo[]>>();
  const seen: AbortSignal[] = [];
  const source = gateway((signal) => {
    seen.push(signal);
    return source.calls.providers === 1 ? initial.promise : manual.promise;
  });
  const devices = createDevices(source.value), current = fixture(devices);
  try {
    const release = startInitialDirectoryRead(current.context);
    const reading = devices.refreshDirectories(new AbortController().signal);
    void reading.catch(() => undefined);
    await turn();
    await release();
    assert.equal(seen[0]?.aborted, true);
    assert.equal(seen[1]?.aborted, false);
    assert.equal(current.events.length, 0, '后发手动读取接管不应报初始化失败');
    manual.resolve({ data: [provider], logId: 'manual-log' });
    await reading;
    initial.resolve({ data: [], logId: 'late-log' });
    await turn();
    assert.deepEqual(devices.snapshot().providers, [provider]);
    assert.deepEqual(source.calls, { providers: 2, directories: 1, discoveries: 0, actions: 0 });
  } finally {
    initial.resolve({ data: [], logId: 'cleanup-log' });
    manual.resolve({ data: [provider], logId: 'cleanup-log' });
    await current.dispose(); devices.dispose();
  }
});
