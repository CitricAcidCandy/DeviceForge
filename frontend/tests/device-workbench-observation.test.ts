import assert from 'node:assert/strict';
import test from 'node:test';
import { act } from 'react';
import { JSDOM } from 'jsdom';
import { HostError } from '../src/plugin-sdk/index.ts';
import type {
  DebugEventInput, DeviceAccess, DeviceProviderInfo, DeviceSnapshot, Dispose, HostContext, HostEvent,
  HostResult, JsonValue, UiAccess,
} from '../src/plugin-sdk/index.ts';
import { createDevices } from '../src/features/devices/models/devices.ts';
import type { DeviceGateway } from '../src/features/devices/models/devices.ts';
import { createWorkspaceRegistry } from '../src/plugins/workspace/index.ts';
import { DEVICE_WORKBENCH_INSTANCE_ID, DEVICES_PLUGIN_ID } from '../plugins/devices/src/contracts.ts';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';
import { deferred } from './fixtures.ts';

const observationKey = 'deviceforge_devices.directory-observation';
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const lateProvider: DeviceProviderInfo = {
  id: 'late_provider', generation: 'old-generation', version: '1.0.0',
  definition: { apiVersion: 3, platform: '测试平台', discoverOperation: 'late.discover', capabilities: [] },
};

async function fixture(read: DeviceGateway['refreshProviders']) {
  const imports = registerCompositionStartupImports();
  assert.deepEqual(imports.diagnostics, []);
  const browser = new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>', {
    url: 'http://127.0.0.1:7031/#/devices', pretendToBeVisual: true,
  });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: browser.window, document: browser.window.document, navigator: browser.window.navigator,
    HTMLElement: browser.window.HTMLElement, Element: browser.window.Element, Node: browser.window.Node,
    HTMLInputElement: browser.window.HTMLInputElement, HTMLButtonElement: browser.window.HTMLButtonElement,
    HTMLSelectElement: browser.window.HTMLSelectElement, HTMLFormElement: browser.window.HTMLFormElement,
    DocumentFragment: browser.window.DocumentFragment, NodeFilter: browser.window.NodeFilter,
    MutationObserver: browser.window.MutationObserver, CustomEvent: browser.window.CustomEvent,
    getComputedStyle: browser.window.getComputedStyle.bind(browser.window),
    requestAnimationFrame: browser.window.requestAnimationFrame.bind(browser.window),
    cancelAnimationFrame: browser.window.cancelAnimationFrame.bind(browser.window), IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  Object.defineProperty(browser.window.HTMLDialogElement.prototype, 'showModal', { configurable: true,
    value(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(browser.window.HTMLDialogElement.prototype, 'close', { configurable: true,
    value(this: HTMLDialogElement) { this.open = false; } });
  const { installPublicUi } = await import('../src/app/public-ui.ts');
  const removeUi = installPublicUi();
  const { default: createDevicesPlugin } = await import('../plugins/devices/src/index.ts');
  // 先载入真实展示模块，避免测试TSX转译时间占用生产首读的五秒期限。
  await import('../plugins/devices/src/workbench.tsx');
  await import('../plugins/devices/src/view.tsx');
  const lifetime = new AbortController(), registry = createWorkspaceRegistry();
  const releases: Dispose[] = [], debugEvents: DebugEventInput[] = [];
  const states = new Map<string, JsonValue>(), eventListeners = new Map<string, Set<(value: HostEvent) => void>>();
  const stateListeners = new Map<string, Set<(value: JsonValue) => void>>();
  const deviceListeners = new Set<(snapshot: DeviceSnapshot) => void>(), operationListeners = new Set<() => void>();
  const mountReleases = new Set<Dispose>(), closing = new Set<Promise<void>>();
  const counts = { providers: 0, aggregates: 0, directories: 0, discoveries: 0, actions: 0, selections: 0, states: 0 };
  const providerSignals: AbortSignal[] = [];
  const model = createDevices({
    refreshProviders(signal) { counts.providers++; providerSignals.push(signal); return read(signal); },
    async refreshDirectories() { counts.directories++; return { data: [], logId: 'directory-log' }; },
    async refreshProvider() { counts.discoveries++; throw new Error('工作台观测单元不得发现设备'); },
    async invoke() { counts.actions++; throw new Error('工作台观测单元不得执行设备动作'); },
  });
  const devices: DeviceAccess = {
    ...model,
    subscribe(listener) {
      deviceListeners.add(listener);
      const release = model.subscribe(listener);
      return () => { deviceListeners.delete(listener); return release(); };
    },
    select(reference) { counts.selections++; model.select(reference); },
    refreshDirectories(signal) { counts.aggregates++; return model.refreshDirectories(signal); },
  };
  const access = registry.access({ pluginId: DEVICES_PLUGIN_ID, generation: 1, signal: lifetime.signal });
  const ui: UiAccess = {
    ...access,
    async mount(instanceId, target, signal) {
      signal.throwIfAborted();
      const resolved = registry.resolveView(instanceId);
      assert.ok(resolved, `公开挂载需要当前实例：${instanceId}`);
      const controller = new AbortController();
      const ownedSignal = AbortSignal.any([signal, resolved.instance.signal, lifetime.signal, controller.signal]);
      const surface = browser.window.document.createElement('div'); target.append(surface);
      const release = await resolved.definition.mount(surface, { ...context, signal: ownedSignal }, resolved.instance);
      let disposed = false;
      const close = async () => {
        if (disposed) return;
        disposed = true;
        ownedSignal.removeEventListener('abort', abort); mountReleases.delete(close);
        controller.abort();
        try { await release(); } finally { surface.remove(); }
      };
      const abort = () => {
        const pending = Promise.resolve().then(close); closing.add(pending);
        void pending.finally(() => { closing.delete(pending); });
      };
      mountReleases.add(close); ownedSignal.addEventListener('abort', abort, { once: true });
      if (ownedSignal.aborted) await close();
      return close;
    },
  };
  const forbidden = async (): Promise<never> => { throw new Error('工作台观测单元不得执行任务或真实请求'); };
  const context: HostContext = {
    apiVersion: 2, signal: lifetime.signal, ui, devices, submit: forbidden, getJob: forbidden, cancelJob: forbidden,
    listOperations: async () => ({ data: [], logId: null }),
    subscribeOperations(listener) {
      const notify = () => listener([]); operationListeners.add(notify);
      return () => { operationListeners.delete(notify); };
    },
    onDispose(release) { releases.push(release); return release; },
    extensions: {
      catalog: () => ({ components: [], modules: [], commands: [], services: [] }),
      executeCommand: forbidden, callService: forbidden,
      subscribeEvent(name, listener) {
        let group = eventListeners.get(name); if (!group) { group = new Set(); eventListeners.set(name, group); }
        group.add(listener); return () => { group.delete(listener); };
      },
      emitEvent(name, data) {
        const event: HostEvent = { name, data, pluginId: DEVICES_PLUGIN_ID, generation: 1 };
        for (const listener of [...eventListeners.get(name) ?? []]) listener(event);
      },
      getState: (key) => states.get(key),
      setState(key, value) {
        const copy = structuredClone(value); states.set(key, copy); counts.states++;
        for (const listener of [...stateListeners.get(key) ?? []]) listener(copy);
      },
      subscribeState(key, listener) {
        let group = stateListeners.get(key); if (!group) { group = new Set(); stateListeners.set(key, group); }
        group.add(listener); return () => { group.delete(listener); };
      },
    },
    debug: { emit: (event) => { debugEvents.push(event); },
      registerNode: () => { throw new Error('工作台观测单元不登记调试节点'); },
      registerResource: (_definition, release) => release },
  };
  const element = browser.window.document.getElementById('root'); assert.ok(element);
  await act(async () => {
    const plugin = createDevicesPlugin({ id: DEVICES_PLUGIN_ID, version: '0.1.0', apiVersion: 2 });
    await plugin.activate?.(context);
    ui.setVisible(DEVICE_WORKBENCH_INSTANCE_ID, true);
    assert.ok(ui.mount);
    await ui.mount(DEVICE_WORKBENCH_INSTANCE_ID, element, lifetime.signal);
  });
  let stopped = false;
  return {
    element, ui, devices, counts, debugEvents, providerSignals,
    observation() {
      const value = states.get(observationKey);
      assert.ok(value && typeof value === 'object' && !Array.isArray(value), '工作台观测须由所属插件的状态入口发布');
      return value;
    },
    async flush() { await act(async () => { await turn(); }); },
    async click(name: string) {
      const button = [...element.querySelectorAll<HTMLButtonElement>('button')]
        .find((item) => (item.getAttribute('aria-label') ?? item.textContent?.trim()) === name);
      assert.ok(button, `缺少按钮：${name}`);
      await act(async () => { button.click(); await turn(); });
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      await act(async () => {
        lifetime.abort();
        for (const release of releases.reverse()) await release();
        await Promise.all([...mountReleases].map((release) => release()));
        await Promise.all([...closing]);
      });
      assert.equal(deviceListeners.size, 0);
      assert.equal(operationListeners.size, 0);
      assert.ok([...stateListeners.values()].every((group) => group.size === 0));
      assert.ok([...eventListeners.values()].every((group) => group.size === 0));
      assert.equal(element.querySelector('[data-product-page="devices"]'), null);
    },
    async dispose() {
      try { await this.stop(); }
      finally {
        model.dispose(); registry.dispose(); await removeUi(); imports.dispose(); browser.window.close();
        for (const [name, descriptor] of saved) {
          if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
        }
      }
    },
  };
}

test('首读挂起不阻塞工作台登记和显示，确认零提供者后才呈现原空态', async () => {
  const pending = deferred<HostResult<readonly DeviceProviderInfo[]>>();
  const f = await fixture(() => pending.promise);
  try {
    assert.equal(f.ui.catalog().pages.find((page) => page.route === '/devices')?.title, '设备');
    assert.ok(f.element.querySelector('[data-product-page="devices"]'));
    assert.match(f.element.textContent ?? '', /正在读取设备目录/);
    assert.doesNotMatch(f.element.textContent ?? '', /还没有可用的设备提供者/);
    assert.equal(f.counts.aggregates, 1);
    assert.equal(f.counts.directories, 0);
    pending.resolve({ data: [], logId: 'empty-provider-log' });
    await f.flush();
    assert.match(f.element.textContent ?? '', /还没有可用的设备提供者/);
    assert.equal(f.element.querySelector('a[href="#/marketplace"]')?.textContent, '去市场页启用');
    assert.doesNotMatch(f.element.textContent ?? '', /正在读取设备目录/);
    assert.equal(f.observation().status, 'confirmed');
    assert.equal(f.counts.aggregates, 1);
    assert.equal(f.counts.providers, 1);
    assert.equal(f.counts.directories, 1);
    assert.equal(f.counts.discoveries + f.counts.actions + f.counts.selections, 0);
  } finally {
    pending.resolve({ data: [], logId: 'cleanup-log' });
    await f.dispose();
  }
});

test('首读失败显示原日志，显式目录读取成功恢复空态且历史失败保留', async () => {
  let reads = 0;
  const f = await fixture(async () => {
    if (++reads === 1) throw new HostError('http', 'directory_failed', '首读测试失败', 'original-directory-log');
    return { data: [], logId: 'manual-empty-log' };
  });
  try {
    await f.flush();
    assert.match(f.element.textContent ?? '', /设备目录读取失败/);
    assert.match(f.element.textContent ?? '', /original-directory-log/);
    assert.doesNotMatch(f.element.textContent ?? '', /还没有可用的设备提供者/);
    assert.equal(f.counts.aggregates, 1, '失败不自动重试聚合目录');
    assert.equal(f.debugEvents.length, 1);
    assert.equal(f.debugEvents[0]?.metadata?.logId, 'original-directory-log');
    const historical = structuredClone(f.debugEvents);
    await f.click('打开设备目录');
    assert.ok(f.element.querySelector('section[aria-label="选择设备"]'));
    await f.click('读取目录');
    assert.equal(f.observation().status, 'confirmed', '成功的零提供者观测也必须结束失败状态');
    await f.click('退出设备选择');
    assert.equal(f.element.querySelector('section[aria-label="选择设备"]'), null);
    assert.match(f.element.textContent ?? '', /还没有可用的设备提供者/);
    assert.doesNotMatch(f.element.textContent ?? '', /设备目录读取失败|original-directory-log/);
    assert.deepEqual(f.debugEvents, historical, '新成功不擦掉本次历史失败诊断');
    assert.equal(f.counts.aggregates, 2);
    assert.equal(f.counts.providers, 2);
    assert.equal(f.counts.directories, 1);
    assert.equal(f.counts.discoveries + f.counts.actions + f.counts.selections, 0);
  } finally { await f.dispose(); }
});

test('手动目录接管首读后旧取消和晚到结果不覆盖当前状态，退出释放订阅', async () => {
  const initial = deferred<HostResult<readonly DeviceProviderInfo[]>>();
  const manual = deferred<HostResult<readonly DeviceProviderInfo[]>>();
  let reads = 0;
  const f = await fixture(() => ++reads === 1 ? initial.promise : manual.promise);
  try {
    const before = f.observation();
    assert.equal(before.status, 'pending');
    assert.equal(typeof before.requestId, 'string');
    await f.click('打开设备目录');
    await f.click('读取目录');
    const owned = f.observation();
    assert.equal(owned.status, 'pending');
    assert.notEqual(owned.requestId, before.requestId, '显式读取拥有独立观测身份');
    assert.equal(f.providerSignals[0]?.aborted, true);
    assert.equal(f.providerSignals[1]?.aborted, false);
    manual.resolve({ data: [], logId: 'manual-current-log' });
    await f.flush();
    await f.click('退出设备选择');
    const confirmed = structuredClone(f.observation());
    assert.equal(confirmed.status, 'confirmed');
    initial.resolve({ data: [lateProvider], logId: 'late-old-log' });
    await f.flush();
    assert.deepEqual(f.observation(), confirmed);
    assert.deepEqual(f.devices.snapshot().providers, []);
    assert.match(f.element.textContent ?? '', /还没有可用的设备提供者/);
    assert.doesNotMatch(f.element.textContent ?? '', /设备目录读取失败|late-old-log/);
    assert.equal(f.debugEvents.length, 0, '接管导致的旧取消不登记为新失败');
    assert.equal(f.counts.aggregates, 2);
    assert.equal(f.counts.discoveries + f.counts.actions + f.counts.selections, 0);
    await f.stop();
    const finalWrites = f.counts.states;
    await f.flush();
    assert.equal(f.counts.states, finalWrites, '卸载后不再发布旧观测');
  } finally {
    initial.resolve({ data: [], logId: 'cleanup-initial-log' });
    manual.resolve({ data: [], logId: 'cleanup-manual-log' });
    await f.dispose();
  }
});
