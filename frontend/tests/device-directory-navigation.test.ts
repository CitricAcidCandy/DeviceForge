import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import type {
  DeviceProviderInfo, DeviceRef, DeviceSnapshot, Dispose, HostContext, HostEvent, JsonValue, UiAccess,
} from '../src/plugin-sdk/index.ts';
import { createWorkspaceRegistry } from '../src/plugins/workspace/index.ts';
import {
  DEVICE_APPS_VIEW, DEVICE_DIRECTORY_VIEW_ID, DEVICE_SCREEN_VIEW, DEVICE_WORKBENCH_INSTANCE_ID,
  DEVICE_WORKBENCH_VIEW_ID, DEVICES_PLUGIN_ID, DEVICES_WORKSPACE_ID, deviceTarget,
} from '../plugins/devices/src/contracts.ts';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';

const reference: DeviceRef = { providerId: 'directory_provider', generation: 'provider-1', localId: 'device-1' };
const provider: DeviceProviderInfo = { id: reference.providerId, generation: reference.generation, version: '1.0.0',
  definition: { apiVersion: 3, platform: '测试平台', discoverOperation: 'directory_provider.discover', capabilities: [] } };

async function fixture() {
  const imports = registerCompositionStartupImports();
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
    value(this: HTMLDialogElement) { this.open = false; this.dispatchEvent(new browser.window.Event('close')); } });
  const { installPublicUi } = await import('../src/app/public-ui.ts');
  const removeUi = installPublicUi();
  const { createRoot } = await import('react-dom/client');
  const { DeviceWorkbench } = await import('../plugins/devices/src/workbench.tsx');
  const { createWorkbenchChildren } = await import('../plugins/devices/src/workbench-children.ts');
  const { mountDirectory } = await import('../plugins/devices/src/view.tsx');
  const { DIRECTORY_NAVIGATION_EVENT } = await import('../plugins/devices/src/directory-navigation.ts');
  const lifetime = new AbortController(), registry = createWorkspaceRegistry();
  const access = registry.access({ pluginId: DEVICES_PLUGIN_ID, generation: 1, signal: lifetime.signal });
  const events: HostEvent[] = [], states = new Map<string, JsonValue>();
  const listeners = new Map<string, Set<(event: HostEvent) => void>>();
  const deviceListeners = new Set<(snapshot: DeviceSnapshot) => void>();
  const operationListeners = new Set<() => void>(), requests: string[] = [];
  const cleanup = new Set<Dispose>(), pendingCleanup = new Set<Promise<void>>();
  const unavailable = async (): Promise<never> => { requests.push('forbidden'); throw new Error('目录导航单元不能执行真实业务'); };
  const device = { reference, state: 'online' as const, model: '导航测试设备', capabilities: [] };
  const snapshot: DeviceSnapshot = { providers: [provider], directories: [{ provider, devices: [device],
    observedAt: 1000, discoveryJobId: 'fixture-history' }], selected: device, selection: reference };
  const ui: UiAccess = {
    ...access,
    async mount(instanceId, target, signal) {
      signal.throwIfAborted();
      const resolved = registry.resolveView(instanceId);
      assert.ok(resolved, `公开挂载必须取得当前实例：${instanceId}`);
      const childSignal = AbortSignal.any([signal, resolved.instance.signal, lifetime.signal]);
      const surface = browser.window.document.createElement('div'); target.append(surface);
      const release = await resolved.definition.mount(surface, { ...context, signal: childSignal }, resolved.instance);
      let disposed = false;
      const close = async () => {
        if (disposed) return;
        disposed = true;
        childSignal.removeEventListener('abort', aborted); cleanup.delete(close);
        try { await release(); } finally { surface.remove(); }
      };
      const aborted = () => {
        const pending = Promise.resolve().then(close); pendingCleanup.add(pending);
        void pending.finally(() => { pendingCleanup.delete(pending); });
      };
      cleanup.add(close);
      childSignal.addEventListener('abort', aborted, { once: true });
      if (childSignal.aborted) await close();
      return close;
    },
  };
  const context: HostContext = {
    apiVersion: 2, signal: lifetime.signal, ui, listOperations: async () => ({ data: [], logId: null }),
    subscribeOperations(listener) { const notify = () => listener([]); operationListeners.add(notify);
      return () => { operationListeners.delete(notify); }; },
    submit: unavailable, getJob: unavailable, cancelJob: unavailable, onDispose: (release) => release,
    devices: { snapshot: () => snapshot,
      subscribe(listener) { deviceListeners.add(listener); return () => { deviceListeners.delete(listener); }; },
      select() { requests.push('select'); }, refreshProviders: unavailable, refreshDirectories: unavailable,
      refreshProvider: unavailable, invoke: unavailable },
    extensions: { catalog: () => ({ components: [], modules: [], commands: [], services: [] }),
      executeCommand: unavailable, callService: unavailable,
      subscribeEvent(name, listener) {
        let group = listeners.get(name); if (!group) { group = new Set(); listeners.set(name, group); }
        group.add(listener); return () => { group.delete(listener); };
      },
      emitEvent(name, data) {
        const event: HostEvent = { name, data, pluginId: DEVICES_PLUGIN_ID, generation: 1 };
        events.push(event); for (const listener of [...listeners.get(name) ?? []]) listener(event);
      },
      getState: (key) => states.get(key), setState: (key, value) => { states.set(key, structuredClone(value)); },
      subscribeState: () => () => {},
    },
  };
  access.register({ workspaces: [{ id: DEVICES_WORKSPACE_ID, title: '设备' }], views: [
    { id: DEVICE_WORKBENCH_VIEW_ID, title: '设备工作台', mount: unavailable },
    { id: DEVICE_DIRECTORY_VIEW_ID, title: '设备目录', mount: async (target, mounted, instance) => mountDirectory(target, mounted, instance) },
  ] });
  for (const view of [DEVICE_SCREEN_VIEW, DEVICE_APPS_VIEW]) registry.access({
    pluginId: view.pluginId, generation: 1, signal: lifetime.signal,
  }).register({ views: [{ id: view.viewId, title: '测试子视图', mount: async (target) => {
    const label = browser.window.document.createElement('div'); label.setAttribute('aria-label', '画面子视图');
    target.append(label); return () => { label.remove(); };
  } }] });
  ui.open({ instanceId: DEVICE_WORKBENCH_INSTANCE_ID, workspaceId: DEVICES_WORKSPACE_ID,
    provider: { pluginId: DEVICES_PLUGIN_ID, viewId: DEVICE_WORKBENCH_VIEW_ID }, target: deviceTarget(reference), visible: true });
  const resolved = registry.resolveView(DEVICE_WORKBENCH_INSTANCE_ID); assert.ok(resolved);
  let parent = resolved.instance, children = createWorkbenchChildren(context, parent);
  const element = browser.window.document.getElementById('root'); assert.ok(element);
  const root = createRoot(element);
  const render = async () => { await act(async () => { root.render(createElement(DeviceWorkbench, {
    key: parent.snapshot().generation, context, instance: parent, children,
  })); }); };
  await render();
  const button = (name: string | RegExp, within: ParentNode = element) => {
    const found = [...within.querySelectorAll<HTMLButtonElement>('button')].find((item) => {
      const label = item.getAttribute('aria-label') ?? item.textContent?.trim() ?? '';
      return typeof name === 'string' ? label === name : name.test(label);
    });
    assert.ok(found, `缺少导航按钮：${name}`); return found;
  };
  return {
    element, ui, states, events, requests, directoryId: () => children.directoryInstanceId,
    screenId: () => children.screenInstanceId,
    directory: () => element.querySelector('section[aria-label="选择设备"]'),
    generation: () => {
      const current = ui.snapshot().instances.find((entry) => entry.instanceId === children.directoryInstanceId);
      assert.ok(current); return current.generation;
    },
    async click(name: string | RegExp, within?: ParentNode) { await act(async () => { button(name, within).click(); }); },
    async query(value: string) {
      const input = element.querySelector<HTMLInputElement>('input[aria-label="搜索设备"]'); assert.ok(input);
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(browser.window.HTMLInputElement.prototype, 'value')?.set;
        assert.ok(setter); setter.call(input, value); input.dispatchEvent(new browser.window.Event('input', { bubbles: true }));
      });
    },
    async nextTarget() {
      await act(async () => {
        children.dispose();
        ui.setTarget(DEVICE_WORKBENCH_INSTANCE_ID, deviceTarget({ ...reference, localId: 'device-2' }));
        const changed = registry.resolveView(DEVICE_WORKBENCH_INSTANCE_ID); assert.ok(changed);
        parent = changed.instance; children = createWorkbenchChildren(context, parent);
        root.render(createElement(DeviceWorkbench, { key: parent.snapshot().generation, context, instance: parent, children }));
      });
    },
    async emitClose(generation: number) {
      await act(async () => { context.extensions?.emitEvent(DIRECTORY_NAVIGATION_EVENT,
        { instanceId: children.directoryInstanceId, generation, action: 'close' }); });
    },
    async hideBeforeSubscription() {
      const previous = parent;
      parent = {
        signal: previous.signal,
        snapshot: previous.snapshot,
        subscribeVisibility(listener) {
          ui.setVisible(DEVICE_WORKBENCH_INSTANCE_ID, false);
          return previous.subscribeVisibility(listener);
        },
      };
      await render();
    },
    async setVisible(visible: boolean) {
      await act(async () => { ui.setVisible(DEVICE_WORKBENCH_INSTANCE_ID, visible); });
    },
    async dispose() {
      try {
        await act(async () => {
          children.dispose(); root.unmount(); lifetime.abort();
          await Promise.all([...cleanup].map((release) => release()));
          await Promise.all([...pendingCleanup]);
        });
        assert.equal(deviceListeners.size, 0); assert.equal(operationListeners.size, 0);
        assert.ok([...listeners.values()].every((group) => group.size === 0));
        assert.deepEqual(requests, [], '导航与草稿恢复不得读取设备目录或执行业务');
      } finally {
        registry.dispose(); await removeUi(); imports.dispose(); browser.window.close();
        for (const [name, descriptor] of saved) {
          if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
        }
      }
    },
  };
}

test('工作台以公开挂载打开完整设备选择页，返回恢复画面且连接弹层不关闭目录', async () => {
  const f = await fixture();
  try {
    assert.ok(f.element.querySelector('[aria-label="画面子视图"]'));
    await f.click('设备目录');
    const directory = f.directory(); assert.ok(directory);
    assert.equal(directory.closest('dialog'), null, '目录应覆盖工作台内容，不再放入模态弹层');
    assert.equal(directory.querySelector('h1')?.textContent, '选择设备');
    assert.equal(f.ui.snapshot().instances.find((entry) => entry.instanceId === f.screenId())?.visible, false);
    assert.equal(f.ui.snapshot().instances.find((entry) => entry.instanceId === f.directoryId())?.visible, true);

    const generation = f.generation();
    await f.click('退出设备选择', directory);
    assert.equal(f.directory(), null);
    assert.equal(f.ui.snapshot().instances.find((entry) => entry.instanceId === f.screenId())?.visible, true);
    const close = f.events.at(-1); assert.ok(close);
    assert.equal(close.name, 'deviceforge_devices.directory.navigation');
    assert.equal(close.pluginId, DEVICES_PLUGIN_ID);
    assert.equal(close.generation, 1);
    assert.deepEqual(close.data, { instanceId: f.directoryId(), generation, action: 'close' });

    await f.click('设备目录');
    await f.click('连接地址', f.directory() ?? undefined);
    const dialog = f.element.querySelector<HTMLDialogElement>('dialog[open]'); assert.ok(dialog);
    assert.equal(dialog.querySelector('h2')?.textContent, '连接与断开设备');
    assert.ok(f.directory(), '连接表单应位于完整选择页之上');
    await f.click('关闭连接与断开设备', dialog);
    assert.equal(f.element.querySelector('dialog[open]'), null);
    assert.ok(f.directory(), '关闭连接弹层后继续留在目录');
    assert.equal(f.ui.snapshot().instances.find((entry) => entry.instanceId === f.screenId())?.visible, false);
  } finally { await f.dispose(); }
});

test('目标换代后目录保持打开及搜索来源草稿，旧目录代次事件不能关闭新目录', async () => {
  const f = await fixture();
  try {
    await f.click('设备目录');
    const directory = f.directory(); assert.ok(directory);
    await f.query('导航测试');
    const sources = directory.querySelector('[role="group"][aria-label="设备来源"]'); assert.ok(sources);
    await f.click(/^测试平台/, sources);
    const retained = [...f.states.values()].find((value) => value !== null && typeof value === 'object'
      && !Array.isArray(value) && value.query === '导航测试');
    assert.deepEqual(retained, { open: true, query: '导航测试', source: '测试平台' });

    const id = f.directoryId(), previousGeneration = f.generation();
    await f.nextTarget();
    assert.equal(f.directoryId(), id);
    assert.notEqual(f.generation(), previousGeneration);
    const restored = f.directory(); assert.ok(restored, '新工作台应从本插件公开状态恢复目录打开状态');
    assert.equal(restored.querySelector<HTMLInputElement>('input[aria-label="搜索设备"]')?.value, '导航测试');
    const selectedSource = restored.querySelector('[aria-label="设备来源"] button[aria-pressed="true"]');
    assert.match(selectedSource?.textContent ?? '', /测试平台/);

    await f.emitClose(previousGeneration);
    assert.ok(f.directory(), '同实例旧代次的返回事件必须忽略');
    await f.emitClose(f.generation());
    assert.equal(f.directory(), null);
    assert.equal(f.ui.snapshot().instances.find((entry) => entry.instanceId === f.screenId())?.visible, true);
  } finally { await f.dispose(); }
});

test('工作台订阅前已隐藏时关闭旧弹层，恢复不重开且保留设备目录草稿', async () => {
  const f = await fixture();
  try {
    await f.click('设备目录');
    await f.query('导航草稿');
    await f.click('连接地址', f.directory() ?? undefined);
    assert.ok(f.element.querySelector('dialog[open]'));
    await f.hideBeforeSubscription();
    assert.ok(f.element.querySelector('dialog[open]') === null, '订阅前遗漏隐藏通知也必须关闭旧连接弹层');
    assert.ok(f.directory() === null, '隐藏后完整目录不应继续占据工作台');
    for (const id of [f.screenId(), f.directoryId()]) {
      assert.equal(f.ui.snapshot().instances.find((entry) => entry.instanceId === id)?.visible, false);
    }
    await f.setVisible(true);
    assert.ok(f.element.querySelector('dialog[open]') === null, '重新显示不自动打开旧连接弹层');
    assert.ok(f.directory() === null);
    assert.equal(f.ui.snapshot().instances.find((entry) => entry.instanceId === f.screenId())?.visible, true);
    await f.click('设备目录');
    assert.equal(f.directory()?.querySelector<HTMLInputElement>('input[aria-label="搜索设备"]')?.value, '导航草稿');
    assert.deepEqual(f.requests, [], '恢复和草稿不得自动发现、连接、选择或执行设备动作');
  } finally { await f.dispose(); }
});
