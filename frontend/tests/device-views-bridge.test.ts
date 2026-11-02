import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import { workspacePluginPackages } from '../scripts/workspace-plugin-packages.ts';
import type { Dispose, HostContext, JsonValue, UiAccess, WorkspaceMount } from '../src/plugin-sdk/index.ts';
import { createWorkspaceRegistry } from '../src/plugins/workspace/index.ts';
import { createPointRegistry } from '../src/plugins/points/index.ts';
import { deviceTarget, screenWorkbenchTarget, DEVICE_APPS_INSTANCE_ID, DEVICE_APPS_VIEW, DEVICE_SCREEN_VIEW,
  DEVICE_WORKBENCH_INSTANCE_ID, DEVICES_PLUGIN_ID } from '../plugins/devices/src/model.ts';
import { DEVICE_WORKBENCH_PANE_EVENT } from '../plugins/devices/src/model.ts';
import { directory } from './device-fixtures.ts';
import { deferred, requestUrl, signal, success } from './fixtures.ts';

const browser = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/', pretendToBeVisual: true,
});
const globals: Readonly<Record<string, unknown>> = {
  window: browser.window, document: browser.window.document, navigator: browser.window.navigator,
  Element: browser.window.Element, HTMLElement: browser.window.HTMLElement, Node: browser.window.Node,
  DocumentFragment: browser.window.DocumentFragment, MutationObserver: browser.window.MutationObserver,
  HTMLInputElement: browser.window.HTMLInputElement, HTMLTextAreaElement: browser.window.HTMLTextAreaElement,
  HTMLSelectElement: browser.window.HTMLSelectElement, HTMLButtonElement: browser.window.HTMLButtonElement,
  HTMLFormElement: browser.window.HTMLFormElement,
  HTMLCanvasElement: browser.window.HTMLCanvasElement, HTMLVideoElement: browser.window.HTMLVideoElement,
  Event: browser.window.Event, CustomEvent: browser.window.CustomEvent,
  localStorage: browser.window.localStorage,
  getComputedStyle: browser.window.getComputedStyle.bind(browser.window),
  requestAnimationFrame: browser.window.requestAnimationFrame.bind(browser.window),
  cancelAnimationFrame: browser.window.cancelAnimationFrame.bind(browser.window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
Object.defineProperty(browser.window.HTMLMediaElement.prototype, 'pause', { configurable: true, value() {} });
const aliases = new Map(workspacePluginPackages(resolve(import.meta.dirname, '..')).aliases.map((item) => [item.find, item.replacement]));
aliases.set('@deviceforge/plugin-sdk', resolve(import.meta.dirname, '../src/plugin-sdk/index.ts'));
const loader = registerHooks({
  resolve(specifier, context, next) {
    const path = aliases.get(specifier);
    return path ? { shortCircuit: true, url: pathToFileURL(path).href } : next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('.css')) return { shortCircuit: true, format: 'module', source: '' };
    if (url.startsWith('file:') && new URL(url).pathname.endsWith('.tsx')) return {
      shortCircuit: true, format: 'module',
      source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        fileName: url, compilerOptions: {
          target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX,
        },
      }).outputText,
    };
    return next(url, context);
  },
});
const { createRoot } = await import('react-dom/client');
const { createProductServices } = await import('../src/app/product/services.ts');
const { createDeviceViewsBridge } = await import('../src/app/product/device-views.tsx');
const { DeviceScreen } = await import('../src/pages/devices/screen/index.tsx');
const { default: createDeviceAppsPlugin } = await import('../plugins/device-apps/src/index.ts');
const { default: createDevicesPlugin } = await import('../plugins/devices/src/index.ts');
const { installPublicUi } = await import('../src/app/public-ui.ts');

const first = { providerId: 'first-provider', generation: 'g1', localId: 'same-id' };
const second = { providerId: 'second-provider', generation: 'g2', localId: 'same-id' };
async function fixture(appsMount?: WorkspaceMount) {
  const requests: { path: string; method: string }[] = [];
  const observed = [directory(first.providerId, first.generation, [first.localId]),
    directory(second.providerId, second.generation, [second.localId])];
  const services = createProductServices({
    baseUrl: 'http://localhost:7031', panelTarget: () => null,
    transport: async (input, init) => {
      const path = requestUrl(input).pathname;
      requests.push({ path, method: init?.method ?? 'GET' });
      if (path === '/api/v2/device-providers') return success(observed.map((item) => item.provider));
      if (path === '/api/v2/devices') return success(observed);
      if (path === '/api/v2/session-definitions') return success({ revision: 1, sessions: [] });
      if (path === '/api/v2/plugins/mirroring/recovery') return success({
        id: 'mirroring', generation: 'm1', supported: true,
        cleanup_failed: false, recovering: false, last_report: null,
      });
      throw new Error(`本单元不允许该请求：${path}`);
    },
  });
  await services.runtime.devices.refreshProviders(signal());
  await services.runtime.devices.refreshDirectories(signal());
  services.runtime.devices.select(first);
  const owner = new AbortController();
  let appsOwner = new AbortController();
  const releases: Dispose[] = [];
  const registry = createWorkspaceRegistry();
  const points = createPointRegistry();
  const baseExtensions = (() => {
    const value = services.runtime.host.extensions;
    assert.ok(value);
    return value;
  })();
  function extensions(pluginId: string, generation: number, signal: AbortSignal) {
    return { ...baseExtensions, points: points.access({ pluginId, generation, signal, track: (release) => release }) };
  }
  const context: HostContext = {
    ...services.runtime.host,
    signal: owner.signal,
    ui: access(DEVICE_SCREEN_VIEW.pluginId, 1, owner),
    extensions: extensions(DEVICE_SCREEN_VIEW.pluginId, 1, owner.signal),
    onDispose: (release) => { releases.push(release); return release; },
  };
  const bridge = createDeviceViewsBridge(services);
  assert.ok(bridge.activate);
  await bridge.activate(context);
  assert.deepEqual(registry.catalog().views.map((view) => view.id), [DEVICE_SCREEN_VIEW.viewId],
    '宿主桥只提供画面，不能再登记或恢复旧应用');
  let appsContext: HostContext = {
    ...context,
    signal: appsOwner.signal,
    ui: access(DEVICE_APPS_VIEW.pluginId, 1, appsOwner),
    extensions: extensions(DEVICE_APPS_VIEW.pluginId, 1, appsOwner.signal),
  };
  const appsPlugin = createDeviceAppsPlugin({ id: DEVICE_APPS_VIEW.pluginId, version: '0.1.0', apiVersion: 2 });
  assert.ok(appsPlugin.activate);
  await appsPlugin.activate(appsContext);
  function access(pluginId: string, generation: number, controller: AbortController): UiAccess {
    return {
      ...registry.access({ pluginId, generation, signal: controller.signal }),
      async mount(id, element, caller) {
        caller.throwIfAborted();
        const resolved = registry.resolveView(id);
        if (!resolved) throw new Error('测试公开挂载目标暂不可用');
        const provider = resolved.instance.snapshot().provider?.pluginId;
        const source = provider === DEVICE_APPS_VIEW.pluginId ? appsContext : context;
        const mount = provider === DEVICE_APPS_VIEW.pluginId ? appsMount ?? resolved.definition.mount : resolved.definition.mount;
        return mount(element, { ...source, signal: AbortSignal.any([source.signal, caller]) }, resolved.instance);
      },
    };
  }
  const releasePublicUi = installPublicUi();
  const consumer = registry.access({ pluginId: 'test_shell', generation: 1, signal: owner.signal });
  const mounted = new Set<Dispose>();
  let sequence = 0;
  async function open(kind: 'screen' | 'apps', targetValue: JsonValue, visible = true) {
    const id = `test_shell.view.${++sequence}`;
    consumer.open({
      instanceId: id, workspaceId: 'test_shell.workspace',
      provider: kind === 'screen' ? DEVICE_SCREEN_VIEW : DEVICE_APPS_VIEW,
      target: targetValue, visible,
    });
    const resolved = registry.resolveView(id);
    assert.ok(resolved);
    const element = browser.window.document.createElement('div');
    browser.window.document.body.append(element);
    let dispose: Dispose = () => {};
    await act(async () => { dispose = await resolved.definition.mount(element,
      kind === 'screen' ? context : appsContext, resolved.instance); });
    mounted.add(dispose);
    return { id, element, dispose };
  }
  async function cleanup() {
    await act(async () => {
      for (const release of mounted) await release();
      appsOwner.abort();
      owner.abort();
      for (const release of releases.reverse()) await release();
    });
    await services.dispose();
    await releasePublicUi();
    registry.dispose();
    points.dispose();
    browser.window.document.body.replaceChildren();
  }
  return { services, requests, initialRequests: [...requests], registry, consumer, context, open, mounted, cleanup,
    stopApps() { appsOwner.abort(); },
    async reloadApps() {
      appsOwner.abort(); appsOwner = new AbortController();
      appsContext = { ...context, signal: appsOwner.signal, ui: access(DEVICE_APPS_VIEW.pluginId, 2, appsOwner),
        extensions: extensions(DEVICE_APPS_VIEW.pluginId, 2, appsOwner.signal) };
      const replacement = createDeviceAppsPlugin({ id: DEVICE_APPS_VIEW.pluginId, version: '0.1.0', apiVersion: 2 });
      assert.ok(replacement.activate); await replacement.activate(appsContext);
    },
  };
}

after(() => {
  loader.deregister();
  browser.window.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('画面桥和独立应用插件各自提供真实视图，不重复挂载整个设备页', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(f.registry.catalog().views.map((view) => view.id), [DEVICE_SCREEN_VIEW.viewId, DEVICE_APPS_VIEW.viewId]);
    const tasks = f.context.extensions?.points?.list({ id: 'deviceforge_devices.task-operations', version: '1' });
    assert.deepEqual(tasks?.find((entry) => entry.provider.pluginId === DEVICE_SCREEN_VIEW.pluginId)?.data,
      { operations: ['runtime.status', 'record', 'open'].map((action) => `plugin.mirroring.${action}`) });
    const screen = await f.open('screen', deviceTarget(first), false);
    const apps = await f.open('apps', deviceTarget(first));
    assert.ok(screen.element.querySelector('canvas[aria-label="设备实时投屏画面"]'));
    assert.equal(screen.element.querySelector('[data-product-section="apps"]'), null);
    assert.ok(apps.element.querySelector('[data-product-section="apps"]'));
    assert.equal(apps.element.querySelector('canvas'), null);
    assert.equal(apps.element.querySelector('[data-product-page="devices"]'), null);
    assert.deepEqual(f.requests, f.initialRequests);
  } finally { await f.cleanup(); }
});

test('严格匹配提供者与代次，不因localId相同而改选设备或执行目标业务', async () => {
  const f = await fixture();
  try {
    for (const reference of [second, { ...first, generation: 'wrong-generation' }]) {
      const screen = await f.open('screen', deviceTarget(reference));
      assert.match(screen.element.textContent ?? '', /设备目标已变化/);
      assert.equal(screen.element.querySelector('canvas'), null);
      assert.deepEqual(f.services.runtime.devices.snapshot().selection, first);
      await act(async () => { await screen.dispose(); });
    }
    const absent = await f.open('apps', deviceTarget(null));
    assert.match(absent.element.textContent ?? '', /请在设备目录选择设备/);
    assert.equal(absent.element.querySelector('[data-product-section="apps"]'), null);
    assert.deepEqual(f.requests, f.initialRequests);
  } finally { await f.cleanup(); }
});

test('应用视图隐藏与恢复保留同一实例及草稿，不提交任务或重新读取', async () => {
  const f = await fixture();
  try {
    const apps = await f.open('apps', deviceTarget(first));
    const input = apps.element.querySelector('input[aria-label="筛选应用标识"]');
    assert.ok(input instanceof browser.window.HTMLInputElement);
    const setter = Object.getOwnPropertyDescriptor(browser.window.HTMLInputElement.prototype, 'value')?.set;
    assert.ok(setter);
    await act(async () => {
      setter.call(input, 'my.unsaved.draft');
      input.dispatchEvent(new browser.window.Event('input', { bubbles: true }));
    });
    await act(async () => { f.consumer.setVisible(apps.id, false); });
    assert.equal(apps.element.querySelector('input[aria-label="筛选应用标识"]'), input);
    assert.ok(apps.element.querySelector('[data-active="false"][hidden][inert]'));
    assert.equal(input.value, 'my.unsaved.draft');
    await act(async () => { f.consumer.setVisible(apps.id, true); });
    assert.equal(apps.element.querySelector('input[aria-label="筛选应用标识"]'), input);
    assert.equal(input.value, 'my.unsaved.draft');
    assert.ok(apps.element.querySelector('[data-active="true"]'));
    assert.deepEqual(f.requests, f.initialRequests);
  } finally { await f.cleanup(); }
});

test('实例换代即时释放旧挂载，旧释放句柄不会拆除新代视图', async () => {
  const f = await fixture();
  try {
    const original = await f.open('screen', deviceTarget(first), false);
    await act(async () => { f.services.runtime.devices.select(second); });
    assert.match(original.element.textContent ?? '', /设备目标已变化/);
    await act(async () => { f.consumer.setTarget(original.id, deviceTarget(second)); });
    assert.equal(original.element.childNodes.length, 0);
    const current = f.registry.resolveView(original.id);
    assert.ok(current);
    let release: Dispose = () => {};
    await act(async () => { release = await current.definition.mount(original.element, f.context, current.instance); });
    f.mounted.add(release);
    assert.ok(original.element.querySelector('canvas'));
    await act(async () => { await original.dispose(); });
    assert.ok(original.element.querySelector('canvas'));
    assert.equal(original.element.getAttribute('data-device-generation'), null);
    assert.equal(original.element.querySelector('[data-device-generation]')?.getAttribute('data-device-generation'),
      String(current.instance.snapshot().generation));
    assert.deepEqual(f.requests, f.initialRequests);
  } finally { await f.cleanup(); }
});

test('剩余画面单实例资源拒绝重复挂载，原视图不受影响且释放后可重新挂载', async () => {
  const f = await fixture();
  try {
    const screen = await f.open('screen', deviceTarget(first), false);
    await assert.rejects(f.open('screen', deviceTarget(first), false), /目前只支持一个挂载实例/);
    assert.ok(screen.element.querySelector('canvas'));
    await act(async () => { await screen.dispose(); });
    const next = await f.open('screen', deviceTarget(first), false);
    assert.ok(next.element.querySelector('canvas'));
    assert.deepEqual(f.requests, f.initialRequests);
  } finally { await f.cleanup(); }
});

test('投屏公开开关默认兼容，关闭应用入口时即使pane为apps也只显示参数', async () => {
  const f = await fixture();
  const element = browser.window.document.createElement('div');
  browser.window.document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => { root.render(createElement(DeviceScreen, { services: f.services, active: false, pane: 'apps' })); });
    assert.equal(element.querySelector('.device-workbench')?.getAttribute('data-pane'), 'apps');
    assert.ok([...element.querySelectorAll('[role="tab"]')].some((tab) => tab.textContent === '应用'));
    await act(async () => { root.render(createElement(DeviceScreen, {
      services: f.services, active: false, pane: 'apps', applicationPane: false,
    })); });
    assert.equal(element.querySelector('.device-workbench')?.getAttribute('data-pane'), 'params');
    assert.equal([...element.querySelectorAll('[role="tab"]')].some((tab) => tab.textContent === '应用'), false);
    assert.equal(element.querySelector('[data-product-section="apps"]'), null);
    assert.deepEqual(f.requests, f.initialRequests);
  } finally {
    await act(async () => { root.unmount(); });
    await f.cleanup();
  }
});

test('画面可见性沿原active入口暂停读取，隐藏保留组件且不派发会话写入', async () => {
  const f = await fixture();
  try {
    const screen = await f.open('screen', deviceTarget(first), false);
    const canvas = screen.element.querySelector('canvas');
    assert.ok(canvas);
    assert.deepEqual(f.requests, f.initialRequests);
    await act(async () => { f.consumer.setVisible(screen.id, true); });
    const reads = f.requests.slice(f.initialRequests.length);
    assert.ok(reads.length > 0);
    assert.ok(reads.every((request) => request.method === 'GET' &&
      ['/api/v2/session-definitions', '/api/v2/plugins/mirroring/recovery'].includes(request.path)));
    const count = f.requests.length;
    await act(async () => { f.consumer.setVisible(screen.id, false); });
    assert.equal(screen.element.querySelector('canvas'), canvas);
    assert.ok(screen.element.querySelector('[data-device-view="screen"][hidden]'));
    assert.equal(f.requests.length, count);
  } finally { await f.cleanup(); }
});

test('工作台应用慢挂载不被提供者loaded通知取消，原画面和应用草稿保持', async () => {
  const ready = deferred<void>();
  const attempts: AbortSignal[] = [];
  let releases = 0;
  const f = await fixture(async (target, context) => {
    attempts.push(context.signal);
    const input = target.ownerDocument.createElement('input');
    input.setAttribute('aria-label', '待完成的应用草稿');
    target.append(input);
    await ready.promise;
    return () => { releases++; input.remove(); };
  });
  try {
    f.registry.access({ pluginId: DEVICES_PLUGIN_ID, generation: 1, signal: f.context.signal }).open({
      instanceId: DEVICE_APPS_INSTANCE_ID, workspaceId: 'deviceforge_devices.workspace',
      provider: DEVICE_APPS_VIEW, target: deviceTarget(first), visible: false,
    });
    const screen = await f.open('screen', screenWorkbenchTarget(first));
    const canvas = screen.element.querySelector('canvas');
    const tab = [...screen.element.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((entry) => entry.textContent === '应用');
    assert.ok(canvas && tab);
    const requests = [...f.requests];
    await act(async () => tab.click());
    assert.equal(attempts.length, 1);
    const input = screen.element.querySelector<HTMLInputElement>('input[aria-label="待完成的应用草稿"]');
    assert.ok(input);
    input.value = '慢挂载期间输入的草稿';
    await act(async () => {
      f.context.extensions?.emitEvent('host.plugins.changed', {
        pluginId: DEVICE_APPS_VIEW.pluginId, generation: 1, stage: 'loaded',
      });
    });
    assert.equal(attempts.length, 1, '当前公开挂载会等待就绪，loaded不能取消后重挂');
    assert.equal(attempts[0]?.aborted, false);
    await act(async () => { ready.resolve(); });
    assert.equal(screen.element.querySelector('canvas'), canvas);
    assert.equal(screen.element.querySelector('input[aria-label="待完成的应用草稿"]'), input);
    assert.equal(input.value, '慢挂载期间输入的草稿');
    assert.deepEqual(f.requests, requests);
    await act(async () => { await screen.dispose(); });
    assert.equal(releases, 1);
  } finally {
    ready.resolve();
    await f.cleanup();
  }
});

test('工作台应用失败不随loaded通知重放，显式重新打开保留画面并可继续', async () => {
  let attempts = 0;
  const f = await fixture(async (target) => {
    attempts++;
    if (attempts === 1) throw new Error('应用挂载结果未确认');
    const input = target.ownerDocument.createElement('input');
    input.setAttribute('aria-label', '显式恢复的应用草稿');
    target.append(input);
    return () => input.remove();
  });
  try {
    f.registry.access({ pluginId: DEVICES_PLUGIN_ID, generation: 1, signal: f.context.signal }).open({
      instanceId: DEVICE_APPS_INSTANCE_ID, workspaceId: 'deviceforge_devices.workspace',
      provider: DEVICE_APPS_VIEW, target: deviceTarget(first), visible: false,
    });
    const screen = await f.open('screen', screenWorkbenchTarget(first));
    const canvas = screen.element.querySelector('canvas');
    const tab = [...screen.element.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((entry) => entry.textContent === '应用');
    assert.ok(canvas && tab);
    const requests = [...f.requests];
    await act(async () => tab.click());
    assert.match(screen.element.textContent ?? '', /应用挂载结果未确认/);
    await act(async () => {
      f.context.extensions?.emitEvent('host.plugins.changed', {
        pluginId: DEVICE_APPS_VIEW.pluginId, generation: 1, stage: 'loaded',
      });
    });
    assert.equal(attempts, 1);
    assert.match(screen.element.textContent ?? '', /应用挂载结果未确认/);
    const retry = [...screen.element.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent === '重新打开应用');
    assert.ok(retry);
    await act(async () => retry.click());
    assert.equal(attempts, 2);
    assert.ok(screen.element.querySelector('input[aria-label="显式恢复的应用草稿"]'));
    assert.equal(screen.element.querySelector('canvas'), canvas);
    assert.deepEqual(f.requests, requests);
  } finally { await f.cleanup(); }
});

test('工作台原应用页签公开挂载独立插件，切面不重建画面或草稿，停用不回退内置应用', async () => {
  const f = await fixture();
  try {
    f.registry.access({ pluginId: 'deviceforge_devices', generation: 1, signal: f.context.signal }).open({
      instanceId: DEVICE_APPS_INSTANCE_ID, workspaceId: 'deviceforge_devices.workspace',
      provider: DEVICE_APPS_VIEW, target: deviceTarget(first), visible: false,
    });
    const screen = await f.open('screen', screenWorkbenchTarget(first));
    const canvas = screen.element.querySelector('canvas');
    assert.ok(canvas);
    assert.equal(screen.element.querySelector('[data-product-section="apps"]'), null, '打开应用页签前不挂载应用业务');
    const apps = [...screen.element.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent === '应用');
    const params = [...screen.element.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent === '画面参数');
    assert.ok(apps && params); assert.equal(apps.disabled, false);
    const requests = [...f.requests];
    await act(async () => apps.click());
    const input = screen.element.querySelector('input[aria-label="筛选应用标识"]');
    assert.ok(input instanceof browser.window.HTMLInputElement);
    assert.equal(screen.element.querySelectorAll('[data-product-section="apps"]').length, 1);
    const setter = Object.getOwnPropertyDescriptor(browser.window.HTMLInputElement.prototype, 'value')?.set;
    assert.ok(setter);
    await act(async () => {
      setter.call(input, '保留的筛选草稿');
      input.dispatchEvent(new browser.window.Event('input', { bubbles: true }));
    });
    await act(async () => params.click());
    assert.equal(screen.element.querySelector('canvas'), canvas);
    assert.equal(screen.element.querySelector('input[aria-label="筛选应用标识"]'), input);
    assert.ok(input.closest('[hidden][inert]'));
    assert.equal(f.registry.snapshot().instances.find((entry) => entry.instanceId === DEVICE_APPS_INSTANCE_ID)?.visible, false);
    await act(async () => apps.click());
    assert.equal(input.value, '保留的筛选草稿');
    assert.equal(f.registry.snapshot().instances.find((entry) => entry.instanceId === DEVICE_APPS_INSTANCE_ID)?.visible, true);
    await act(async () => f.consumer.setVisible(screen.id, false));
    assert.equal(screen.element.querySelector('input[aria-label="筛选应用标识"]'), input);
    assert.equal(f.registry.snapshot().instances.find((entry) => entry.instanceId === DEVICE_APPS_INSTANCE_ID)?.visible, false);
    await act(async () => f.consumer.setVisible(screen.id, true));
    assert.equal(input.value, '保留的筛选草稿');
    await act(async () => f.stopApps());
    assert.equal(screen.element.querySelector('canvas'), canvas);
    assert.equal(screen.element.querySelector('[data-product-section="apps"]'), null);
    assert.equal(apps.disabled, true);
    await act(async () => f.reloadApps());
    assert.equal(apps.disabled, false);
    assert.ok(screen.element.querySelector('[data-product-section="apps"]'));
    assert.notEqual(screen.element.querySelector('input[aria-label="筛选应用标识"]'), input);
    assert.ok(f.requests.slice(requests.length).every((request) => request.method === 'GET'));
    const stage = screen.element.querySelector('.device-workbench');
    assert.ok(stage?.classList.contains('@max-[1024px]/device-screen:grid-cols-[minmax(0,1fr)]'));
    assert.ok(stage?.parentElement?.classList.contains('@container/device-screen'));
    const rail = screen.element.querySelector('.workbench-rail');
    assert.ok(rail?.classList.contains('@max-[1024px]/device-screen:row-start-2'));
    assert.ok(screen.element.querySelector('.media-stage-readout')?.classList.contains('@max-[1024px]/device-screen:left-[62px]'));
    const origins: HostContext[] = [];
    f.services.runtime.webPlugins.register({ id: DEVICES_PLUGIN_ID, trusted: true, plugin: {
      id: DEVICES_PLUGIN_ID, version: '0.1.0', apiVersion: 2, panels: [],
      activate: async (context) => { origins.push(context); },
    } });
    await f.services.runtime.webPlugins.load(DEVICES_PLUGIN_ID);
    const extensions = origins[0]?.extensions; assert.ok(extensions);
    await act(async () => params.click());
    await act(async () => { extensions.emitEvent(DEVICE_WORKBENCH_PANE_EVENT, { screenInstanceId: 'another-screen', pane: 'apps' }); });
    assert.equal(screen.element.querySelector('.device-workbench')?.getAttribute('data-pane'), 'params');
    await act(async () => { extensions.emitEvent(DEVICE_WORKBENCH_PANE_EVENT, { screenInstanceId: screen.id, pane: 'apps' }); });
    assert.equal(screen.element.querySelector('.device-workbench')?.getAttribute('data-pane'), 'apps');
    assert.equal(screen.element.querySelector('canvas'), canvas);
    assert.equal(screen.element.querySelectorAll('[data-product-section="apps"]').length, 1);
  } finally { await f.cleanup(); }
});

test('设备业务根视图接回竖工具和显式目录，公开子挂载不重复创建应用或自动发现', async () => {
  const f = await fixture();
  const document = browser.window.document;
  const element = document.createElement('div');
  document.body.append(element);
  const prototype = browser.window.HTMLDialogElement.prototype;
  const originalShow = Object.getOwnPropertyDescriptor(prototype, 'showModal');
  const originalClose = Object.getOwnPropertyDescriptor(prototype, 'close');
  Object.defineProperty(prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(prototype, 'close', { configurable: true, value(this: HTMLDialogElement) {
    this.open = false; this.dispatchEvent(new browser.window.Event('close'));
  } });
  try {
    assert.ok(f.context.ui?.mount);
    const { extensions: _extensions, ...base } = f.context;
    const ui: UiAccess = { ...f.registry.access({ pluginId: DEVICES_PLUGIN_ID, generation: 1, signal: f.context.signal }), mount: f.context.ui.mount };
    const context = { ...base, ui };
    const plugin = createDevicesPlugin({ id: DEVICES_PLUGIN_ID, version: '0.1.0', apiVersion: 2 });
    assert.ok(plugin.activate); await plugin.activate(context);
    ui.setVisible(DEVICE_WORKBENCH_INSTANCE_ID, true);
    const root = f.registry.resolveView(DEVICE_WORKBENCH_INSTANCE_ID);
    assert.ok(root);
    let release: Dispose = () => {};
    await act(async () => { release = await root.definition.mount(element, context, root.instance); });
    f.mounted.add(release);
    const canvas = element.querySelector('canvas');
    assert.ok(canvas);
    assert.equal(element.querySelectorAll('[data-product-page="devices"]').length, 1);
    assert.equal(element.querySelectorAll('[data-product-section="apps"]').length, 0);
    assert.ok(element.querySelector('nav[aria-label="设备工具"] a[href="#/performance"]'));
    assert.ok(element.querySelector('nav[aria-label="设备工具"] a[href="#/terminal"]'));
    const connectButton = element.querySelector<HTMLButtonElement>('button[aria-label="连接设备"]');
    const capabilitiesButton = element.querySelector<HTMLButtonElement>('button[aria-label="能力与原始结果"]');
    assert.ok(connectButton && capabilitiesButton);
    assert.equal(capabilitiesButton.disabled, false);
    const directoryButton = element.querySelector<HTMLButtonElement>('button[aria-label="设备目录"]');
    const dialog = element.querySelector('dialog');
    assert.ok(directoryButton && dialog); assert.equal(dialog.open, false);
    const requests = [...f.requests];
    await act(async () => directoryButton.click());
    assert.equal(dialog.open, true);
    assert.ok(dialog.querySelector('button[role="radio"], input[type="radio"]'));
    assert.equal(element.querySelector('canvas'), canvas);
    assert.deepEqual(f.requests, requests);
    await act(async () => { dialog.dispatchEvent(new browser.window.Event('cancel', { cancelable: true })); });
    assert.equal(dialog.open, false);
    assert.equal(element.querySelector('canvas'), canvas);
    await act(async () => connectButton.click());
    assert.ok(element.querySelector('[data-product-section="devices-connect"]'), '连接工具必须打开真实业务表单而不是目录');
    assert.equal(element.querySelectorAll('dialog[open]').length, 1);
    assert.equal(dialog.open, false);
    const closeConnection = element.querySelector<HTMLButtonElement>('button[aria-label="关闭连接与断开设备"]');
    assert.ok(closeConnection);
    await act(async () => closeConnection.click());
    await act(async () => capabilitiesButton.click());
    assert.ok(element.querySelector('[data-product-section="device-capabilities"]'));
    assert.equal(element.querySelectorAll('dialog[open]').length, 1);
    await act(async () => ui.setVisible(DEVICE_WORKBENCH_INSTANCE_ID, false));
    assert.equal(element.querySelectorAll('dialog[open]').length, 0);
    assert.ok(element.querySelector('[data-device-view="screen"][hidden]'));
    assert.ok(f.requests.every((request) => request.method === 'GET'));
    for (const label of ['添加功能', '编辑布局', '停靠方式']) assert.equal(element.textContent?.includes(label), false);
  } finally {
    await f.cleanup();
    if (originalShow) Object.defineProperty(prototype, 'showModal', originalShow); else Reflect.deleteProperty(prototype, 'showModal');
    if (originalClose) Object.defineProperty(prototype, 'close', originalClose); else Reflect.deleteProperty(prototype, 'close');
  }
});
