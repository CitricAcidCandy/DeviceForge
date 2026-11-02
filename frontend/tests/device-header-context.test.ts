import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeviceHeader } from '../plugins/devices/src/header-model.ts';
import { registerDeviceHeader } from '../plugins/devices/src/header-registration.ts';
import { deviceIdentity } from '../plugins/devices/src/contracts.ts';
import { HostError } from '../src/plugin-sdk/index.ts';
import type {
  DeviceAccess, DeviceDirectory, DeviceProviderInfo, DeviceRef, DeviceSnapshot, Dispose,
  HostContext, HostResult, PointAccess, PointRef,
} from '../src/plugin-sdk/index.ts';
import { createPointRegistry } from '../src/plugins/points/index.ts';
import { createWorkspaceRegistry } from '../src/plugins/workspace/index.ts';
import { deferred } from './fixtures.ts';

const first: DeviceRef = { providerId: 'first_provider', generation: 'generation-1', localId: 'same-id' };
const second: DeviceRef = { providerId: 'second_provider', generation: 'generation-2', localId: 'same-id' };
const third: DeviceRef = { providerId: 'third_provider', generation: 'generation-3', localId: 'same-id' };
function directory(reference: DeviceRef): DeviceDirectory {
  return {
    provider: {
      id: reference.providerId, generation: reference.generation, version: '1.0.0',
      definition: { apiVersion: 3, platform: '自定义平台',
        discoverOperation: `${reference.providerId}.discover`, capabilities: [] },
    },
    observedAt: 1, discoveryJobId: `job-${reference.providerId}`,
    devices: [{ reference, model: '公开设备', state: 'online', capabilities: [] }],
  };
}
const firstDirectory = directory(first), secondDirectory = directory(second), thirdDirectory = directory(third);
const directories = [firstDirectory, secondDirectory, thirdDirectory];

function deviceFixture(options: {
  readonly refreshProviders?: DeviceAccess['refreshProviders'];
  readonly refreshProvider?: DeviceAccess['refreshProvider'];
} = {}) {
  let state: DeviceSnapshot = {
    providers: directories.map((entry) => entry.provider), directories, selection: first,
    selected: firstDirectory.devices[0] ?? null,
  };
  const listeners = new Set<(value: DeviceSnapshot) => void>();
  const calls: string[] = [];
  const signals: AbortSignal[] = [];
  const notify = () => { for (const listener of [...listeners]) listener(state); };
  const devices: DeviceAccess = {
    snapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    select(reference) {
      state = {
        ...state, selection: reference,
        selected: state.directories.flatMap((entry) => entry.devices)
          .find((entry) => deviceIdentity(entry.reference) === deviceIdentity(reference)) ?? null,
      };
      notify();
    },
    async refreshProviders(signal) {
      calls.push('providers'); signals.push(signal);
      return options.refreshProviders
        ? options.refreshProviders(signal) : { data: state.providers, logId: 'providers-log' };
    },
    async refreshProvider(id, generation, signal) {
      calls.push(`${id}@${generation}`); signals.push(signal);
      if (options.refreshProvider) return options.refreshProvider(id, generation, signal);
      const found = directories.find((entry) => entry.provider.id === id && entry.provider.generation === generation);
      assert.ok(found, '发现必须使用本次公开目录中的完整提供者身份');
      return { data: found, logId: `discovery-${id}` };
    },
    async refreshDirectories() { calls.push('directories'); throw new Error('顶栏发现不得用旧目录读取替代提供者发现'); },
    async invoke() { calls.push('invoke'); throw new Error('顶栏发现不得派发设备动作'); },
  };
  return {
    devices, calls, signals, count: () => listeners.size,
    replace(next: DeviceSnapshot) { state = next; notify(); },
  };
}
function hostFixture(extra: Partial<HostContext> = {}) {
  const lifetime = new AbortController(), releases: Dispose[] = [], requests: string[] = [];
  const forbidden = async (name: string): Promise<never> => {
    requests.push(name); throw new Error(`顶栏不得调用 ${name}`);
  };
  const host: HostContext = {
    apiVersion: 2, signal: lifetime.signal,
    listOperations: () => forbidden('listOperations'), submit: () => forbidden('submit'),
    getJob: () => forbidden('getJob'), cancelJob: () => forbidden('cancelJob'),
    subscribeOperations: () => () => {},
    onDispose(release) { releases.push(release); return release; },
    ...extra,
  };
  return {
    host, requests,
    async dispose() {
      lifetime.abort();
      for (const release of releases.reverse()) await release();
    },
  };
}
function extensions(points: PointAccess): NonNullable<HostContext['extensions']> {
  return {
    points, register: () => () => {},
    catalog: () => ({ components: [], modules: [], commands: [], services: [] }),
    executeCommand: async () => { throw new Error('测试不执行命令'); },
    callService: async () => { throw new Error('测试不调用服务'); },
    subscribeEvent: () => () => {}, emitEvent() {},
    getState: () => undefined, setState() {}, subscribeState: () => () => {},
  };
}
async function flush() {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}

test('顶栏创建只订阅公开设备快照，完整身份选择与失效选项互不误清，销毁释放订阅', async () => {
  const current = deviceFixture(), host = hostFixture({ devices: current.devices });
  const model = createDeviceHeader(host.host);
  let changes = 0;
  const unsubscribe = model.subscribe(() => { changes++; });
  try {
    assert.deepEqual(current.calls, []);
    assert.deepEqual(host.requests, []);
    assert.deepEqual(model.snapshot().devices, current.devices.snapshot());
    assert.equal(model.snapshot().pending, false);
    assert.equal(model.snapshot().feedback, null);
    assert.equal(current.count(), 1);
    assert.notEqual(deviceIdentity(first), deviceIdentity(second));
    assert.notEqual(deviceIdentity(first), deviceIdentity({ ...first, generation: 'generation-old' }));
    assert.equal(model.select(deviceIdentity(second)), true);
    assert.deepEqual(model.snapshot().devices.selection, second);
    assert.equal(model.select(deviceIdentity({ ...first, generation: 'generation-old' })), false);
    assert.deepEqual(model.snapshot().devices.selection, second, '过期选择不能隐式清空当前设备');
    assert.equal(model.select(null), true);
    assert.equal(model.snapshot().devices.selection, null);
    assert.equal(model.select(deviceIdentity(first)), true);
    assert.ok(changes > 0);
    await unsubscribe();
    await model.dispose();
    assert.equal(current.count(), 0);
    const observed = changes;
    current.replace({ ...current.devices.snapshot(), selection: null, selected: null });
    assert.equal(changes, observed);
  } finally { await model.dispose(); await host.dispose(); }
});

test('顶栏显式发现先刷新提供者再串行发现，单项失败继续且关联失败日志，成功重试保留历史记录', async () => {
  const waiting = deferred<HostResult<DeviceDirectory>>(), history: string[] = [];
  let fails = true;
  const current = deviceFixture({
    async refreshProvider(id) {
      if (id === first.providerId) return waiting.promise;
      if (id === second.providerId && fails) {
        history.push('provider-failure-log');
        throw new HostError('http', 'discovery_failed', '第二提供者发现失败', 'provider-failure-log', 502);
      }
      const result = directories.find((entry) => entry.provider.id === id);
      assert.ok(result);
      return { data: result, logId: `success-${id}` };
    },
  });
  const host = hostFixture({ devices: current.devices }), model = createDeviceHeader(host.host);
  try {
    const pending = model.discover();
    await flush();
    assert.equal(model.snapshot().pending, true);
    assert.deepEqual(current.calls, ['providers', `${first.providerId}@${first.generation}`]);
    waiting.resolve({ data: firstDirectory, logId: 'first-success-log' });
    await pending;
    assert.deepEqual(current.calls, [
      'providers', ...directories.map((entry) => `${entry.provider.id}@${entry.provider.generation}`),
    ]);
    const partial = model.snapshot().feedback;
    assert.equal(model.snapshot().pending, false);
    assert.equal(partial?.outcome, 'partial');
    assert.equal(partial?.logId, 'provider-failure-log');
    assert.ok(partial?.message);
    assert.ok(partial?.details.some((entry) => entry.provider === second.providerId &&
      entry.logId === 'provider-failure-log' && entry.message.includes('第二提供者发现失败')));
    assert.deepEqual(host.requests, []);
    fails = false;
    await model.discover();
    assert.equal(model.snapshot().feedback?.outcome, 'completed');
    assert.deepEqual(history, ['provider-failure-log']);
  } finally { await model.dispose(); await host.dispose(); }
});

test('提供者目录失败和全部发现失败均可诊断，本次失败不阻止独立重试', async () => {
  let catalogFails = true;
  const current = deviceFixture({
    async refreshProviders() {
      if (catalogFails) throw new HostError('network', 'providers_failed', '提供者目录暂不可用', 'catalog-failure-log');
      return { data: directories.map((entry) => entry.provider), logId: 'catalog-success-log' };
    },
    async refreshProvider(id) {
      throw new HostError('http', 'discovery_failed', `发现 ${id} 失败`, `failure-${id}`, 502);
    },
  });
  const host = hostFixture({ devices: current.devices }), model = createDeviceHeader(host.host);
  try {
    await model.discover();
    assert.deepEqual(current.calls, ['providers']);
    assert.equal(model.snapshot().pending, false);
    assert.equal(model.snapshot().feedback?.outcome, 'failed');
    assert.equal(model.snapshot().feedback?.logId, 'catalog-failure-log');
    assert.match(model.snapshot().feedback?.message ?? '', /提供者目录暂不可用/);
    catalogFails = false;
    await model.discover();
    assert.deepEqual(current.calls, [
      'providers', 'providers', ...directories.map((entry) => `${entry.provider.id}@${entry.provider.generation}`),
    ]);
    const failure = model.snapshot().feedback;
    assert.equal(failure?.outcome, 'failed');
    assert.equal(failure?.details.length, 3);
    for (const entry of directories) {
      assert.ok(failure?.details.some((item) => item.provider === entry.provider.id &&
        item.logId === `failure-${entry.provider.id}`));
    }
    assert.deepEqual(host.requests, []);
  } finally { await model.dispose(); await host.dispose(); }
});

test('取消忽略信号的发现仍结束等待并允许立即重试，旧拒绝不能污染新反馈或取消服务器任务', { timeout: 2_000 }, async () => {
  const old = deferred<HostResult<DeviceDirectory>>();
  let stalls = true;
  const current = deviceFixture({
    async refreshProvider(id) {
      if (stalls) { stalls = false; return old.promise; }
      const result = directories.find((entry) => entry.provider.id === id);
      assert.ok(result);
      return { data: result, logId: `new-${id}` };
    },
  });
  const host = hostFixture({ devices: current.devices }), model = createDeviceHeader(host.host);
  try {
    const pending = model.discover();
    await flush();
    assert.deepEqual(current.calls, ['providers', `${first.providerId}@${first.generation}`]);
    model.cancel();
    await pending;
    assert.equal(model.snapshot().pending, false);
    assert.equal(model.snapshot().feedback?.outcome, 'cancelled');
    assert.match(model.snapshot().feedback?.message ?? '', /等待/);
    assert.ok(current.signals.at(-1)?.aborted);
    await model.discover();
    const completed = model.snapshot().feedback;
    assert.equal(completed?.outcome, 'completed');
    old.reject(new HostError('network', 'old_failure', '旧轮次迟到失败', 'old-failure-log'));
    await flush();
    assert.equal(model.snapshot().pending, false);
    assert.deepEqual(model.snapshot().feedback, completed);
    assert.deepEqual(host.requests, []);
    assert.equal(current.calls.filter((entry) => entry === 'providers').length, 2);
  } finally {
    await model.dispose(); await host.dispose();
    assert.equal(current.count(), 0);
  }
});

test('默认三十秒是跨目录和发现的绝对预算，可缩短且卸载同样结束不响应取消的上游等待', { timeout: 2_000 }, async (clock) => {
  clock.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const catalog = deferred<HostResult<readonly DeviceProviderInfo[]>>();
  const hanging = deferred<HostResult<DeviceDirectory>>();
  const current = deviceFixture({
    refreshProviders: () => catalog.promise,
    refreshProvider: () => hanging.promise,
  });
  const host = hostFixture({ devices: current.devices }), model = createDeviceHeader(host.host);
  try {
    const pending = model.discover();
    await flush();
    clock.mock.timers.tick(20_000);
    catalog.resolve({ data: [firstDirectory.provider], logId: 'catalog-log' });
    await flush();
    assert.deepEqual(current.calls, ['providers', `${first.providerId}@${first.generation}`]);
    clock.mock.timers.tick(9_999);
    await flush();
    assert.equal(model.snapshot().pending, true);
    clock.mock.timers.tick(1);
    await pending;
    assert.equal(model.snapshot().pending, false);
    assert.equal(model.snapshot().feedback?.outcome, 'failed');
    assert.match(model.snapshot().feedback?.message ?? '', /超时|期限/);
    assert.ok(current.signals.at(-1)?.aborted);
    await model.dispose();

    const shortened = createDeviceHeader(host.host, { waitMs: 25 });
    try {
      const next = shortened.discover();
      await flush();
      clock.mock.timers.tick(25);
      await next;
      assert.equal(shortened.snapshot().pending, false);
      assert.equal(shortened.snapshot().feedback?.outcome, 'failed');
    } finally { await shortened.dispose(); }

    const unloading = createDeviceHeader(host.host);
    const last = unloading.discover();
    await flush();
    await unloading.dispose();
    await last;
    assert.equal(current.count(), 0);
    assert.deepEqual(host.requests, []);
  } finally { await model.dispose(); await host.dispose(); }
});

test('顶栏视图通过真实公开注册表贡献，扩展点晚到及恢复不重复，撤销保留无关页面和贡献', async () => {
  const workspace = createWorkspaceRegistry(), points = createPointRegistry();
  const current = deviceFixture(), host = hostFixture({ devices: current.devices });
  const external = new AbortController();
  const shellHeader: PointRef = { id: 'deviceforge_shell.header', version: '1' };
  const ownUi = workspace.access({ pluginId: 'deviceforge_devices', generation: 1, signal: host.host.signal });
  const ownPoints = points.access({
    pluginId: 'deviceforge_devices', generation: 1, signal: host.host.signal, track: (release) => release,
  });
  const otherUi = workspace.access({ pluginId: 'other_plugin', generation: 1, signal: external.signal });
  const shellPoints = points.access({
    pluginId: 'deviceforge_shell', generation: 1, signal: external.signal, track: (release) => release,
  });
  const otherPoints = points.access({
    pluginId: 'other_plugin', generation: 1, signal: external.signal, track: (release) => release,
  });
  otherUi.register({ pages: [{
    id: 'other_plugin.page', title: '无关页面', route: '/other', mount: async () => () => {},
  }] });
  otherPoints.contribute({
    id: 'other_plugin.header', point: shellHeader, mode: 'append',
    data: { pluginId: 'other_plugin', viewId: 'other_plugin.header' },
  });
  const releaseHeader = registerDeviceHeader({ ...host.host, ui: ownUi, extensions: extensions(ownPoints) });
  try {
    const contribution = () => points.list(shellHeader)
      .filter((entry) => entry.id === 'deviceforge_devices.header.contribution');
    const views = () => ownUi.catalog().views.filter((entry) => entry.id === 'deviceforge_devices.header');
    assert.equal(views().length, 1);
    assert.equal(contribution().length, 1);
    assert.equal(contribution()[0]?.state, 'waiting');
    assert.equal(contribution()[0]?.mode, 'append');
    assert.deepEqual(contribution()[0]?.data, {
      pluginId: 'deviceforge_devices', viewId: 'deviceforge_devices.header',
    });
    const removePoint = shellPoints.define({ ...shellHeader, title: '外壳顶栏', modes: ['append'] });
    assert.equal(contribution()[0]?.state, 'active');
    await removePoint();
    assert.equal(contribution()[0]?.state, 'waiting');
    shellPoints.define({ ...shellHeader, title: '外壳顶栏', modes: ['append'] });
    assert.equal(contribution().length, 1);
    assert.equal(contribution()[0]?.state, 'active');
    assert.equal(views().length, 1);
    assert.deepEqual(current.calls, []);
    assert.deepEqual(host.requests, []);
    await releaseHeader();
    await releaseHeader();
    assert.equal(contribution().length, 0);
    assert.equal(views().length, 0);
    assert.equal(points.list(shellHeader).filter((entry) => entry.id === 'other_plugin.header').length, 1);
    assert.equal(ownUi.catalog().pages.filter((entry) => entry.id === 'other_plugin.page').length, 1);
  } finally {
    await releaseHeader(); external.abort(); await host.dispose();
    workspace.dispose(); points.dispose();
  }
});
