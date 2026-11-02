import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Dispose, HostContext, UiAccess, WebPlugin, WorkspaceMount } from '../src/plugin-sdk/index.ts';
import { createWorkspaceRegistry } from '../src/plugins/workspace/index.ts';
import { createPointRegistry } from '../src/plugins/points/registry.ts';
import { createMountPool } from '../plugins/default-shell/src/mount-pool.ts';
import { createShellController } from '../plugins/default-shell/src/controller.ts';
import type { ShellState } from '../plugins/default-shell/src/controller.ts';
import { createFrontendRuntime } from '../src/app/runtime.ts';
import type { ShellHostSnapshot } from '../src/app/composition/shell-host.ts';
import { SHELL_POINT } from '../src/app/composition/shell-host.ts';
import type { ProductConnection } from '../src/app/product/services.ts';
import { HostError } from '../src/plugin-sdk/models.ts';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';

const loader = registerCompositionStartupImports();
assert.deepEqual(loader.diagnostics, []);
const { ChromeAddons } = await import('../plugins/default-shell/src/addons.tsx');
const { ViewContent, ViewFrame, FloatingView } = await import('../plugins/default-shell/src/view.tsx');
const { StorageStatus } = await import('../plugins/default-shell/src/storage.tsx');
const { Shell } = await import('../plugins/default-shell/src/shell.tsx');
const { PlatformRecovery, PlatformRecoveryEntry } = await import('../src/app/composition/Recovery.tsx');
const { createProductServices } = await import('../src/app/product/services.ts');
loader.dispose();

function fixture(render?: NonNullable<UiAccess['mount']>) {
  const browser = new JSDOM('<!doctype html><html><body><div id="test"></div></body></html>', {
    url: 'http://127.0.0.1:7031',
  });
  const document = browser.window.document, target = document.getElementById('test');
  assert.ok(target);
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: browser.window, document, navigator: browser.window.navigator, HTMLElement: browser.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const root = createRoot(target);
  const registry = createWorkspaceRegistry();
  const owner = new AbortController(), contributor = new AbortController();
  const points = createPointRegistry();
  const pointAccess = points.access({
    pluginId: 'deviceforge_shell', generation: 1, signal: owner.signal, track: (value: Dispose) => value,
  });
  const addonAccess = points.access({
    pluginId: 'addon', generation: 1, signal: contributor.signal, track: (value: Dispose) => value,
  });
  const business = registry.access({ pluginId: 'business', generation: 1, signal: contributor.signal });
  const mount: WorkspaceMount = async () => () => {};
  business.register({
    pages: [{ id: 'business.page', title: '页面', route: '/example', mount }],
    views: [{ id: 'business.header', title: '顶栏功能', mount }, { id: 'business.next', title: '另一功能', mount }],
  });
  let mounts = 0, releases = 0;
  const ui: UiAccess = {
    ...registry.access({ pluginId: 'deviceforge_shell', generation: 1, signal: owner.signal }),
    mount: render ?? (async (_id, element) => {
      mounts++;
      const input = document.createElement('input');
      input.setAttribute('aria-label', '插件草稿');
      element.append(input);
      return () => { releases++; input.remove(); };
    }),
  };
  const pool = createMountPool(ui, document, owner.signal);
  const unavailable = () => new Promise<never>(() => undefined);
  const context: HostContext = {
    apiVersion: 2, signal: owner.signal, ui,
    listOperations: async () => ({ data: [], logId: null }),
    submit: unavailable, getJob: unavailable, cancelJob: unavailable,
    subscribeOperations: () => () => {}, onDispose: (value) => value,
    extensions: {
      points: pointAccess, catalog: () => ({ components: [], modules: [], commands: [], services: [] }),
      executeCommand: unavailable, callService: unavailable, subscribeEvent: () => () => {}, emitEvent() {},
      getState: () => undefined, setState() {}, subscribeState: () => () => {},
    },
  };
  const controller = createShellController(context, pool, '/example');
  async function cleanup() {
    await act(async () => { root.unmount(); });
    controller.dispose();
    await pool.dispose();
    points.dispose();
    registry.dispose();
    browser.window.close();
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
  return { root, target, context, controller, pool, ui, owner, contributor, pointAccess, addonAccess,
    cleanup, counts: () => ({ mounts, releases }) };
}

function recoveryFixture(state: ShellHostSnapshot, connection?: ProductConnection) {
  const f = fixture();
  const services = createProductServices({
    baseUrl: 'http://127.0.0.1:7031', workspaceStorage: null, panelTarget: () => null,
    ...(connection ? { connection } : {}),
    transport: async () => { throw new Error('恢复界面单元不应发送业务请求'); },
  });
  let retries = 0;
  const shell = { snapshot: () => state, subscribe: () => () => {}, retry() { retries++; }, dispose: async () => {} };
  return { ...f, services, shell, retries: () => retries,
    async cleanup() { await f.cleanup(); await services.dispose(); } };
}

function buttonNamed(target: ParentNode, name: string) {
  const button = [...target.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === name);
  assert.ok(button, `缺少操作按钮：${name}`);
  return button;
}

test('同一显示位置先换实例再到旧清理时只显示当前根，返回保留各自草稿', async () => {
  const f = fixture();
  try {
    const workspaceId = f.controller.snapshot().current?.workspaceId;
    assert.ok(workspaceId);
    const ids = ['deviceforge_shell.first', 'deviceforge_shell.second'];
    for (const instanceId of ids) f.ui.open({
      instanceId, workspaceId, provider: { pluginId: 'business', viewId: 'business.header' },
    });
    async function show(instanceId: string) {
      const detach = f.pool.attach(instanceId, f.target);
      await f.pool.prepare(instanceId);
      assert.deepEqual([...f.target.querySelectorAll<HTMLElement>('[data-shell-view]')]
        .map((element) => element.dataset.shellView), [instanceId]);
      const input = f.target.querySelector<HTMLInputElement>('input[aria-label="插件草稿"]');
      assert.ok(input);
      return { input, detach };
    }
    const first = await show('deviceforge_shell.first');
    first.input.value = '第一页草稿';
    const second = await show('deviceforge_shell.second');
    assert.notEqual(second.input, first.input);
    second.input.value = '第二页草稿';
    await first.detach();
    assert.equal(f.target.querySelector('input'), second.input, '旧位置释放不能拆当前显示');
    const returned = await show('deviceforge_shell.first');
    await second.detach();
    assert.equal(returned.input, first.input);
    assert.equal(first.input.value, '第一页草稿');
    assert.equal((await show('deviceforge_shell.second')).input, second.input);
    assert.equal(second.input.value, '第二页草稿');
    assert.equal(f.counts().mounts, 2);
  } finally { await f.cleanup(); }
});

test('紧凑卡头在同一行显示来源，更多操作保留回调、焦点和业务草稿', async () => {
  const f = fixture();
  const replaced: string[] = [], closed: string[] = [];
  try {
    await f.controller.add({ pluginId: 'business', viewId: 'business.header' }, 'split');
    const instance = f.ui.snapshot().instances.find((item) => item.provider?.viewId === 'business.header');
    assert.ok(instance);
    await act(async () => { f.root.render(createElement(ViewFrame, {
      instanceId: instance.instanceId, state: f.controller.snapshot(), controller: f.controller,
      pool: f.pool, editing: false, onReplace: (id) => replaced.push(id), onClose: (id) => closed.push(id),
    })); });
    const header = f.target.querySelector('section > header');
    assert.ok(header);
    assert.equal(header.querySelector('[aria-label="视图来源"]')?.textContent, 'business');
    const details = header.querySelector<HTMLDetailsElement>('details');
    const more = header.querySelector<HTMLElement>('summary[aria-label="顶栏功能更多操作"]');
    const draft = f.target.querySelector<HTMLInputElement>('input[aria-label="插件草稿"]');
    assert.ok(details && more && draft);
    draft.value = '打开菜单不得丢失';
    const before = f.counts(), window = f.target.ownerDocument.defaultView;
    assert.ok(window);
    more.focus();
    await act(async () => { more.click(); });
    assert.equal(details.open, true);
    await act(async () => { more.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    assert.equal(details.open, false);
    assert.equal(f.target.ownerDocument.activeElement, more);
    await act(async () => { more.click(); buttonNamed(header, '更换提供者').click(); });
    assert.deepEqual(replaced, [instance.instanceId]);
    assert.equal(details.open, false);
    await act(async () => { more.click(); buttonNamed(header, '关闭视图').click(); });
    assert.deepEqual(closed, [instance.instanceId]);
    assert.equal(f.target.ownerDocument.activeElement, more);
    assert.equal(f.target.querySelector('input[aria-label="插件草稿"]'), draft);
    assert.equal(draft.value, '打开菜单不得丢失');
    assert.deepEqual(f.counts(), before);
  } finally { await f.cleanup(); }
});

test('恢复诊断只复制本次失败日志ID，复制失败如实反馈', async () => {
  const f = recoveryFixture({ state: 'failed', active: null, requested: 'broken.shell',
    error: '本次外壳失败', errorLogId: 'shell-failure-log', cleanupErrors: ['另一条历史错误'] });
  const copied: string[] = [];
  let rejected = false;
  try {
    const window = f.target.ownerDocument.defaultView;
    assert.ok(window);
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: {
      async writeText(value: string) { if (rejected) throw new Error('剪贴板拒绝'); copied.push(value); },
    } });
    await act(async () => { f.root.render(createElement(PlatformRecovery, { services: f.services, shell: f.shell })); });
    assert.equal(f.target.querySelector('[aria-label="本次失败日志 ID"]')?.textContent, 'shell-failure-log');
    const details = f.target.querySelector<HTMLElement>('summary[aria-label="查看本次失败详情"]');
    assert.ok(details);
    await act(async () => { details.click(); });
    const copy = f.target.querySelector<HTMLButtonElement>('button[aria-label="复制本次失败日志 ID"]');
    assert.ok(copy);
    assert.equal(copy.disabled, false);
    await act(async () => { copy.click(); });
    assert.deepEqual(copied, ['shell-failure-log']);
    assert.match(f.target.textContent ?? '', /日志 ID 已复制/);
    rejected = true;
    await act(async () => { copy.click(); });
    assert.deepEqual(copied, ['shell-failure-log']);
    assert.match(f.target.textContent ?? '', /复制失败，请手动选择日志 ID/);
  } finally { await f.cleanup(); }
});

test('恢复操作无日志ID时显示未知并禁用复制，不借用外壳旧错误ID', async () => {
  const f = recoveryFixture({ state: 'failed', active: null, requested: 'broken.shell',
    error: '旧外壳错误', errorLogId: 'old-shell-log', cleanupErrors: [] }, {
    baseUrl: 'http://127.0.0.1:7031',
    async reconnect() { throw new HostError('network', 'connection_failed', '本次连接未取得响应'); },
  });
  try {
    await act(async () => { f.root.render(createElement(PlatformRecovery, { services: f.services, shell: f.shell })); });
    await act(async () => { buttonNamed(f.target, '检查连接').click(); });
    const form = f.target.querySelector('form'), window = f.target.ownerDocument.defaultView;
    assert.ok(form && window);
    await act(async () => { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
    assert.match(f.target.textContent ?? '', /本次连接未取得响应/);
    const logId = f.target.querySelector('[aria-label="本次失败日志 ID"]');
    const copy = f.target.querySelector<HTMLButtonElement>('button[aria-label="复制本次失败日志 ID"]');
    assert.ok(logId && copy);
    assert.match(logId.textContent ?? '', /未知/);
    assert.equal(logId.textContent?.includes('old-shell-log'), false);
    assert.equal(copy.disabled, true);
  } finally { await f.cleanup(); }
});

test('无壳恢复使用56和48像素独立顶底栏，简洁入口仍可选择外壳、管理插件和连接', async () => {
  const connections: { readonly address: string; readonly token: string; readonly signal: AbortSignal }[] = [];
  const f = recoveryFixture({ state: 'failed', active: null, requested: 'broken.shell',
    error: '外壳挂载失败', errorLogId: null, cleanupErrors: [] }, {
    baseUrl: 'http://127.0.0.1:7031',
    async reconnect(address, token, signal) { connections.push({ address, token, signal }); },
  });
  const plugin: WebPlugin = { id: 'deviceforge_shell', version: '1.0.0', apiVersion: 2, panels: [],
    async activate(context) {
      context.ui?.register({ views: [{ id: 'deviceforge_shell.root', title: '官方外壳', mount: async () => () => {} }] });
      context.extensions?.points?.contribute({ id: 'deviceforge_shell.shell', point: SHELL_POINT,
        mode: 'replace', data: { pluginId: 'deviceforge_shell', viewId: 'deviceforge_shell.root' } });
    },
  };
  try {
    f.services.runtime.bundledPlugins.register({ id: plugin.id, trusted: true, loader: async () => plugin });
    await f.services.runtime.webPlugins.load(plugin.id);
    const points = f.services.runtime.host.extensions?.points;
    assert.ok(points);
    await act(async () => { f.root.render(createElement(PlatformRecovery, { services: f.services, shell: f.shell })); });
    const frame = f.target.querySelector('[aria-label="平台恢复独立界面"]');
    assert.ok(frame);
    assert.ok(frame.classList.contains('grid-rows-[56px_minmax(0,1fr)_48px]'));
    assert.ok(frame.querySelector(':scope > header')?.classList.contains('h-14'));
    assert.ok(frame.querySelector(':scope > footer')?.classList.contains('h-12'));
    assert.equal(f.target.querySelector('form'), null);
    assert.equal(f.target.querySelector('[aria-label="插件管理"]'), null);
    assert.equal(points.selected(SHELL_POINT), null);
    await act(async () => { buttonNamed(f.target, '选择官方外壳').click(); });
    assert.equal(points.selected(SHELL_POINT)?.id, 'deviceforge_shell.shell');
    assert.equal(f.retries(), 1);
    await act(async () => { buttonNamed(f.target, '管理插件').click(); });
    const management = f.target.querySelector('[aria-label="插件管理"]');
    assert.ok(management);
    assert.match(management.textContent ?? '', /deviceforge_shell/);
    await act(async () => { buttonNamed(management, '停用').click(); });
    assert.notEqual(f.services.runtime.webPlugins.diagnosticSnapshot().find((item) => item.id === plugin.id)?.state, 'loaded');
    await act(async () => { buttonNamed(f.target, '返回恢复概览').click(); });
    await act(async () => { buttonNamed(f.target, '检查连接').click(); });
    const form = f.target.querySelector('form'), window = f.target.ownerDocument.defaultView;
    assert.ok(form && window);
    await act(async () => { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
    assert.deepEqual(connections, [{ address: 'http://127.0.0.1:7031', token: '', signal: f.services.runtime.host.signal }]);
  } finally { await f.cleanup(); }
});

test('恢复概览保留已选外壳的显式重试，不要求重新启用插件', async () => {
  const f = recoveryFixture({ state: 'failed', active: null, requested: 'missing.shell',
    error: '所选提供者暂不可用', errorLogId: null, cleanupErrors: [] });
  try {
    await act(async () => { f.root.render(createElement(PlatformRecovery, { services: f.services, shell: f.shell })); });
    await act(async () => { buttonNamed(f.target, '选择其他外壳').click(); });
    await act(async () => { buttonNamed(f.target, '重新准备所选外壳').click(); });
    assert.equal(f.retries(), 1);
    assert.equal(f.services.runtime.webPlugins.diagnosticSnapshot().length, 0);
  } finally { await f.cleanup(); }
});

test('同址页面冲突不按加载顺序抢占，原视图身份保留且撤销后恢复目录', async () => {
  const f = fixture();
  try {
    const before = f.controller.snapshot().current;
    const release = f.ui.register({ pages: [{
      id: 'deviceforge_shell.conflict', title: '同址页面', route: '/example', mount: async () => () => {},
    }] });
    assert.deepEqual(f.controller.snapshot().routeConflicts, ['/example']);
    assert.equal(f.controller.snapshot().available, false);
    assert.equal(f.controller.snapshot().current?.page.id, before?.page.id);
    assert.equal(f.controller.snapshot().pages.length, 0);
    await release();
    assert.deepEqual(f.controller.snapshot().routeConflicts, []);
    assert.equal(f.controller.snapshot().available, true);
    assert.equal(f.controller.snapshot().current?.page.id, before?.page.id);
  } finally { await f.cleanup(); }
});

test('独立平台恢复入口只渲染一次，打开不卸载外壳或重挂业务草稿', async () => {
  const f = fixture();
  const runtime = createFrontendRuntime({
    baseUrl: 'http://127.0.0.1:7031', workspaceStorage: null, panelTarget: () => null,
    transport: async () => { throw new Error('打开恢复面板不应发送业务请求'); },
  });
  try {
    const services = runtime.host.services;
    assert.ok(services);
    await act(async () => { f.root.render(createElement('div', null,
      createElement(Shell, { context: { ...f.context, services }, controller: f.controller, pool: f.pool }),
      createElement(PlatformRecoveryEntry, { expanded: false, onOpen: () => {
        void services.call({ id: 'host.platform.recovery', version: '1' }, { action: 'open' }, runtime.host.signal);
      } }),
    )); });
    const canvas = f.target.querySelector('[data-workspace-canvas]');
    const before = f.counts();
    const button = [...f.target.querySelectorAll('button')].find((item) => item.textContent === '平台恢复');
    assert.ok(button);
    assert.equal([...f.target.querySelectorAll('button')].filter((item) => item.textContent === '平台恢复').length, 1);
    await act(async () => { button.click(); });
    assert.equal(runtime.recovery.snapshot().open, true);
    assert.equal(f.target.querySelector('[data-workspace-canvas]'), canvas);
    assert.deepEqual(f.counts(), before);
  } finally { await f.cleanup(); await runtime.dispose(); }
});

test('无可用外壳时恢复面板仍可收起，独立入口可以重新打开', async () => {
  const f = fixture();
  const services = createProductServices({
    baseUrl: 'http://127.0.0.1:7031', workspaceStorage: null, panelTarget: () => null,
    transport: async () => { throw new Error('恢复界面单元不应发送业务请求'); },
  });
  const state: ShellHostSnapshot = { state: 'empty', active: null, requested: null, error: null, errorLogId: null, cleanupErrors: [] };
  const shell = { snapshot: () => state, subscribe: () => () => {}, retry() {}, dispose: async () => {} };
  try {
    await act(async () => { f.root.render(createElement(PlatformRecovery, { services, shell })); });
    assert.ok(f.target.querySelector('[role="dialog"]'));
    const close = f.target.querySelector<HTMLButtonElement>('button[aria-label="收起平台恢复"]');
    assert.ok(close);
    await act(async () => { close.click(); });
    assert.equal(f.target.querySelector('[role="dialog"]'), null);
    const open = [...f.target.querySelectorAll('button')].find((button) => button.textContent === '平台恢复');
    assert.ok(open);
    await act(async () => { open.click(); });
    assert.ok(f.target.querySelector('[role="dialog"]'));
  } finally { await f.cleanup(); await services.dispose(); }
});

test('窄窗显示导航文字和下划线页签，切换视图仍复用草稿实例', async () => {
  const f = fixture();
  try {
    await act(async () => { f.root.render(createElement(Shell, { context: f.context, controller: f.controller, pool: f.pool })); });
    const shell = f.target.firstElementChild, window = f.target.ownerDocument.defaultView;
    assert.ok(shell && window);
    Object.defineProperty(shell, 'clientWidth', { configurable: true, value: 940 });
    await act(async () => { window.dispatchEvent(new window.Event('resize')); });
    assert.equal(f.controller.snapshot().compact, true);
    const label = f.target.querySelector('nav button span');
    assert.equal(label?.textContent, '页面');
    assert.equal(label?.className.includes('sr-only'), false);
    const main = f.target.querySelector('main');
    assert.ok(main);
    assert.ok(main.classList.contains('px-6'));
    assert.equal(main.className.includes('max-[1100px]:px-4'), false);
    await act(async () => { await f.controller.add({ pluginId: 'business', viewId: 'business.header' }, 'split'); });
    const tabs = f.target.querySelectorAll<HTMLButtonElement>('[aria-label="窄窗工作区视图"] [role="tab"]');
    assert.equal(tabs.length, 2);
    assert.ok(tabs[0]?.classList.contains('border-b-2'));
    assert.equal(tabs[0]?.className.includes('rounded'), false);
    const first = tabs[0], second = tabs[1];
    assert.ok(first && second);
    await act(async () => { first.click(); });
    const draft = f.target.querySelector<HTMLInputElement>('input[aria-label="插件草稿"]');
    assert.ok(draft); draft.value = '窄窗切页保留';
    await act(async () => { second.click(); });
    await act(async () => { first.click(); });
    assert.equal(f.target.querySelector('input[aria-label="插件草稿"]'), draft);
    assert.equal(draft.value, '窄窗切页保留');
  } finally { await f.cleanup(); }
});

test('顶栏目录的无关更新不重挂现有扩展，业务草稿保留', async () => {
  const f = fixture();
  const point = { id: 'deviceforge_shell.header', version: '1' };
  f.pointAccess.define({ ...point, title: '顶栏', modes: ['append'] });
  f.addonAccess.contribute({ id: 'addon.header', point, data: { pluginId: 'business', viewId: 'business.header' } });
  try {
    await act(async () => { f.root.render(createElement(ChromeAddons, {
      context: f.context, region: 'header', pool: f.pool, state: f.controller.snapshot(),
    })); });
    const input = f.target.querySelector('input');
    assert.ok(input);
    input.value = '未保存的顶栏草稿';
    const before = f.counts();
    await act(async () => {
      f.pointAccess.define({ id: 'deviceforge_shell.unrelated', version: '1', title: '另一扩展点' });
    });
    assert.equal(f.target.querySelector('input'), input);
    assert.equal(input.value, '未保存的顶栏草稿');
    assert.deepEqual(f.counts(), before);
  } finally { await f.cleanup(); }
});

test('真实挂载池延迟成功后跨通知、页面往返与StrictMode重入仍保持可见DOM和草稿', async () => {
  let allowMount = () => {}, mounts = 0, releases = 0;
  const gate = new Promise<void>((resolve) => { allowMount = resolve; });
  const roots = new Map<string, HTMLElement>();
  const f = fixture(async (id, element) => {
    mounts++;
    roots.set(id, element);
    if (mounts === 1) await gate;
    const input = element.ownerDocument.createElement('input');
    input.setAttribute('aria-label', `延迟草稿 ${id}`);
    element.append(input);
    return () => { releases++; input.remove(); };
  });
  const instance = f.ui.snapshot().instances[0];
  assert.ok(instance);
  const render = () => createElement(StrictMode, null,
    createElement(Shell, { context: f.context, controller: f.controller, pool: f.pool }));
  try {
    await act(async () => { f.root.render(render()); });
    assert.equal(f.pool.status(instance.instanceId).state, 'mounting');
    assert.equal(roots.get(instance.instanceId)?.isConnected, true);
    assert.ok(f.target.querySelector('[role="status"][aria-label="正在打开视图"]'));
    await act(async () => { allowMount(); });
    const root = roots.get(instance.instanceId), input = root?.querySelector('input');
    assert.ok(root && input);
    input.value = '页面往返不能丢失';
    const assertVisibleReady = () => {
      assert.equal(f.pool.status(instance.instanceId).state, 'ready');
      assert.equal(root.isConnected, true);
      assert.equal(f.target.contains(root), true);
      assert.equal(input.isConnected, true);
      const container = root.parentElement;
      assert.ok(container);
      for (const name of ['h-full', 'min-h-0', 'min-w-0', 'overflow-auto'])
        assert.equal(container.classList.contains(name), true, `就绪容器缺少响应式高度或局部滚动：${name}`);
      assert.equal(container.classList.contains('min-h-[200px]'), false, '就绪容器不能强迫窄区使用旧最小页高');
      assert.equal(input.value, '页面往返不能丢失');
      assert.equal(f.target.querySelector('[aria-label="正在打开视图"]'), null);
      assert.equal(f.target.querySelector('[aria-label="视图暂时无法显示"]'), null);
    };
    assertVisibleReady();
    await act(async () => {
      f.ui.setVisible(instance.instanceId, false);
      f.root.render(render());
    });
    assertVisibleReady();
    await act(async () => {
      f.ui.register({ pages: [{
        id: 'deviceforge_shell.another', title: '另一页面', route: '/another',
        mount: async () => () => {},
      }] });
      f.controller.navigate('/another');
    });
    assert.equal(root.isConnected, false);
    assert.equal(releases, 0);
    await act(async () => { f.controller.navigate('/example'); });
    assertVisibleReady();
    await act(async () => { f.root.render(render()); });
    assertVisibleReady();
    assert.equal(mounts, 2);
    assert.equal(releases, 0);
  } finally { allowMount(); await f.cleanup(); }
  assert.equal(releases, 2);
});

test('单视图等待、加载与失败可按语义读取当前详情，重试仍只操作局部视图', async () => {
  let rejectFirst: ((error: Error) => void) | null = null, attempts = 0;
  const f = fixture(async () => {
    attempts++;
    if (attempts === 1) return new Promise<Dispose>((_resolve, reject) => { rejectFirst = reject; });
    return () => {};
  });
  const instance = f.ui.snapshot().instances[0];
  assert.ok(instance);
  const failurePool = { ...f.pool, attach: () => { throw new Error('当前视图无法取得挂载入口'); } };
  try {
    for (const reason of ['provider_missing', 'owner_inactive'] as const) {
      const current = f.controller.snapshot();
      const state: ShellState = { ...current, model: { ...current.model,
        instances: current.model.instances.map((entry) => entry.instanceId === instance.instanceId
          ? { ...entry, state: 'missing', reason } : entry) } };
      await act(async () => { f.root.render(createElement(ViewContent, {
        instanceId: instance.instanceId, state, pool: f.pool,
      })); });
      const label = reason === 'owner_inactive' ? '视图所属插件已停用' : '等待视图提供者';
      assert.equal(f.target.querySelector('[role="status"]')?.getAttribute('aria-label'), label);
      assert.equal(f.target.querySelector('[role="alert"]'), null);
      const note = f.target.querySelector('[role="note"]');
      assert.ok(note);
      assert.equal(note.getAttribute('aria-label'), `视图技术详情：${note.textContent}`);
    }
    await act(async () => { f.root.render(createElement(ViewContent, {
      instanceId: instance.instanceId, state: f.controller.snapshot(), pool: f.pool,
    })); });
    assert.equal(f.target.querySelector('[role="status"]')?.getAttribute('aria-label'), '正在打开视图');
    assert.equal(f.target.querySelector('[role="alert"]'), null);
    await act(async () => {
      if (!rejectFirst) throw new Error('应已开始本次视图挂载');
      rejectFirst(new Error('当前市场视图参数校验失败'));
    });
    assert.equal(f.target.querySelector('[role="alert"]')?.getAttribute('aria-label'), '视图暂时无法显示');
    assert.equal(f.target.querySelector('[role="note"]')?.getAttribute('aria-label'),
      '视图技术详情：当前市场视图参数校验失败');
    const retry = f.target.querySelector<HTMLButtonElement>('button[aria-label="重新打开视图"]');
    assert.ok(retry);
    assert.equal(retry.textContent, '重新打开视图');
    await act(async () => { retry.click(); });
    assert.equal(attempts, 2);
    assert.equal(f.target.querySelector('[role="alert"]'), null);
    assert.equal(f.target.querySelector('[role="status"]'), null);
    await act(async () => { f.root.render(createElement(ViewContent, {
      instanceId: instance.instanceId, state: f.controller.snapshot(), pool: failurePool,
    })); });
    assert.match(f.target.textContent ?? '', /当前视图无法取得挂载入口/);
    assert.equal(f.target.querySelector('[role="alert"]')?.getAttribute('aria-label'), '视图暂时无法显示');
    assert.equal(f.target.querySelector('[role="note"]')?.getAttribute('aria-label'),
      '视图技术详情：当前视图无法取得挂载入口');
    assert.ok(f.target.querySelector('button[aria-label="重新打开视图"]'));
  } finally { await f.cleanup(); }
});

test('顶栏重新打开时提供者已撤销，局部显示错误而不抛出事件处理器', async () => {
  const f = fixture(async () => { throw new Error('扩展初次挂载失败'); });
  const point = { id: 'deviceforge_shell.header', version: '1' };
  f.pointAccess.define({ ...point, title: '顶栏', modes: ['append'] });
  f.addonAccess.contribute({ id: 'addon.header', point, data: { pluginId: 'business', viewId: 'business.header' } });
  const pool = { ...f.pool, retry: () => { throw new Error('提供者刚刚撤销'); } };
  try {
    await act(async () => { f.root.render(createElement(ChromeAddons, {
      context: f.context, region: 'header', pool, state: f.controller.snapshot(),
    })); });
    const button = [...f.target.querySelectorAll('button')].find((entry) => entry.textContent === '重新打开扩展');
    assert.ok(button);
    await act(async () => { button.click(); });
    assert.match(f.target.textContent ?? '', /提供者刚刚撤销/);
  } finally { await f.cleanup(); }
});

test('重新读取布局明确替换当前布局，须用户再次确认后才调用', async () => {
  const f = fixture();
  const actions: string[] = [];
  const context: HostContext = {
    ...f.context,
    services: {
      catalog: () => [],
      diagnostics: () => [],
      callTyped: async () => { throw new Error('该单元不应调用类型化服务'); },
      whenAvailable: () => () => {},
      call: async (_ref, input) => {
        assert.ok(input && typeof input === 'object' && !Array.isArray(input));
        if (typeof input.action === 'string') actions.push(input.action);
        return { data: {
          enabled: true, state: 'blocked', source: 'invalid', pending: true,
          lastError: { code: 'invalid_source', message: '保存的布局无效' },
        }, logId: null };
      },
    },
  };
  try {
    await act(async () => { f.root.render(createElement(StorageStatus, { context })); });
    const button = [...f.target.querySelectorAll('button')].find((entry) => entry.textContent === '重新读取');
    assert.ok(button);
    await act(async () => { button.click(); });
    assert.deepEqual(actions, ['status']);
    assert.match(f.target.textContent ?? '', /替换当前布局/);
    const confirm = [...f.target.querySelectorAll('button')].find((entry) => entry.textContent === '确认重新读取');
    assert.ok(confirm);
    await act(async () => { confirm.click(); });
    assert.deepEqual(actions, ['status', 'retryRead']);
  } finally { await f.cleanup(); }
});

test('覆盖层读取公开视图锚点几何，Esc退出交互并归还键盘焦点', async () => {
  const f = fixture();
  const document = f.target.ownerDocument, window = document.defaultView;
  assert.ok(window);
  const canvas = document.createElement('div'), anchor = document.createElement('section');
  canvas.dataset.workspaceCanvas = 'true';
  anchor.dataset.shellInstance = 'visible-anchor';
  f.target.replaceWith(canvas);
  canvas.append(anchor, f.target);
  canvas.getBoundingClientRect = () => new window.DOMRect(20, 30, 900, 600);
  anchor.getBoundingClientRect = () => new window.DOMRect(200, 100, 400, 300);
  try {
    const instance = f.ui.open({
      provider: { pluginId: 'business', viewId: 'business.next' },
      workspaceId: 'business.page', instanceId: 'deviceforge_shell.overlay',
    });
    await act(async () => { f.root.render(createElement(FloatingView, {
      controller: f.controller, pool: f.pool, state: f.controller.snapshot(), editing: false,
      onReplace() {}, onClose() {}, overlay: true,
      view: { instanceId: instance.instanceId, relativeTo: 'visible-anchor', x: 20, y: 15, width: 300, height: 140, z: 1 },
    })); });
    const element = f.target.querySelector('section');
    assert.ok(element);
    assert.equal(element.style.getPropertyValue('--shell-x'), '200px');
    assert.equal(element.style.getPropertyValue('--shell-y'), '85px');
    const button = [...f.target.querySelectorAll('button')].find((entry) => entry.textContent === '启用交互');
    assert.ok(button);
    await act(async () => { button.click(); });
    const input = f.target.querySelector('input');
    assert.ok(input);
    input.focus();
    await act(async () => { input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    assert.equal(button.textContent, '启用交互');
    assert.equal(document.activeElement, button);
  } finally { await f.cleanup(); }
});

test('锚点缺失时覆盖层只读等待，不挂载业务或误报当前坐标', async () => {
  const f = fixture();
  const canvas = f.target.ownerDocument.createElement('div');
  canvas.dataset.workspaceCanvas = 'true';
  f.target.replaceWith(canvas);
  canvas.append(f.target);
  try {
    const instance = f.ui.open({
      provider: { pluginId: 'business', viewId: 'business.next' },
      workspaceId: 'business.page', instanceId: 'deviceforge_shell.overlay',
    });
    await act(async () => { f.root.render(createElement(FloatingView, {
      controller: f.controller, pool: f.pool, state: f.controller.snapshot(), editing: false,
      onReplace() {}, onClose() {}, overlay: true,
      view: { instanceId: instance.instanceId, relativeTo: 'missing-anchor', x: 20, y: 15, width: 300, height: 140, z: 1 },
    })); });
    assert.match(f.target.textContent ?? '', /覆盖层锚点暂不可用/);
    const button = [...f.target.querySelectorAll('button')].find((entry) => entry.textContent === '启用交互');
    assert.ok(button);
    assert.equal(button.disabled, true);
    assert.equal(f.target.querySelector('input'), null);
  } finally { await f.cleanup(); }
});
