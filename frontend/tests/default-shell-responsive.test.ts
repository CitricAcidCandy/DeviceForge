import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import type { HostContext, UiAccess, WorkspaceLayout, WorkspaceMount } from '../src/plugin-sdk/index.ts';
import { createWorkspaceRegistry } from '../src/plugins/workspace/index.ts';
import { createPointRegistry } from '../src/plugins/points/index.ts';
import { createMountPool } from '../plugins/default-shell/src/mount-pool.ts';
import { createShellController } from '../plugins/default-shell/src/controller.ts';
import { floatingPosition } from '../plugins/default-shell/src/floating.ts';

const shellSource = new URL('../plugins/default-shell/src/', import.meta.url);
const parser = registerHooks({
  load(url, context, next) {
    if (!url.startsWith(shellSource.href) || !url.endsWith('.tsx')) return next(url, context);
    return {
      format: 'module', shortCircuit: true,
      source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        fileName: fileURLToPath(url),
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
      }).outputText,
    };
  },
});
after(() => parser.deregister());
const { Shell } = await import('../plugins/default-shell/src/shell.tsx');
const split: WorkspaceLayout = {
  version: 1,
  root: { kind: 'split', direction: 'horizontal', weights: [0.6, 0.4], children: [
    { kind: 'view', instanceId: 'deviceforge_shell.one' },
    { kind: 'view', instanceId: 'deviceforge_shell.two' },
  ] },
  floating: [], overlays: [],
};
function classes(element: Element | null, required: readonly string[]) {
  assert.ok(element, '预期的结构节点不存在');
  for (const name of required) assert.ok(element.classList.contains(name), `缺少流式布局类：${name}`);
}
function namedButton(target: ParentNode, label: string) {
  const button = [...target.querySelectorAll<HTMLButtonElement>('button')]
    .find((entry) => entry.textContent?.trim() === label);
  assert.ok(button, `缺少既有按钮：${label}`);
  return button;
}
async function fixture(initialWidth = 1424, layout: WorkspaceLayout = split) {
  const browser = new JSDOM('<!doctype html><html><body><div id="mount"></div></body></html>', {
    url: 'http://127.0.0.1:7031', pretendToBeVisual: true,
  });
  const window = browser.window, document = window.document;
  const target = document.getElementById('mount');
  assert.ok(target);
  let width = initialWidth, canvasWidth = 1200, canvasHeight = 800;
  const measurements = new Set<() => void>();
  Object.defineProperty(window, 'ResizeObserver', {
    configurable: true, value: class {
      constructor(callback: () => void) { this.callback = callback; }
      readonly callback: () => void;
      observe() { measurements.add(this.callback); }
      disconnect() { measurements.delete(this.callback); }
    },
  });
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1424 });
  Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', {
    configurable: true, get(this: HTMLElement) {
      return this.parentElement === target ? width : this.hasAttribute('data-workspace-canvas') ? canvasWidth : 0;
    },
  });
  const originalBounds = window.HTMLElement.prototype.getBoundingClientRect;
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return this.hasAttribute('data-workspace-canvas')
      ? new window.DOMRect(0, 0, canvasWidth, canvasHeight) : originalBounds.call(this);
  };
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window, document, navigator: window.navigator, HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  // 先建立 DOM 再加载渲染器，让输入事件能力检测使用真实夹具环境。
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(target);
  const registry = createWorkspaceRegistry(), lifetime = new AbortController();
  const business = registry.access({ pluginId: 'business', generation: 1, signal: lifetime.signal });
  const mount: WorkspaceMount = async () => () => {};
  business.register({
    pages: [{ id: 'business.page', title: '设备工作区与长标题', route: '/example', workspaceId: 'business.work',
      navigation: { description: '保持既有分栏、页签与插件草稿，不依赖浏览器窗口宽度推断嵌入容器密度。' } }],
    workspaces: [{ id: 'business.work', title: '实际工作区' }],
    views: [
      { id: 'business.one', title: '第一个视图与较长的可读名称', mount },
      { id: 'business.two', title: '第二个视图', mount },
    ],
  });
  const mounted = new Map<string, number>(), released = new Map<string, number>();
  const ui: UiAccess = {
    ...registry.access({ pluginId: 'deviceforge_shell', generation: 1, signal: lifetime.signal }),
    async mount(instanceId, element) {
      mounted.set(instanceId, (mounted.get(instanceId) ?? 0) + 1);
      const input = document.createElement('input');
      input.setAttribute('aria-label', `草稿 ${instanceId}`);
      element.append(input);
      return () => { released.set(instanceId, (released.get(instanceId) ?? 0) + 1); input.remove(); };
    },
  };
  for (const [instanceId, viewId] of [
    ['deviceforge_shell.one', 'business.one'], ['deviceforge_shell.two', 'business.two'],
  ]) {
    assert.ok(instanceId && viewId);
    ui.open({ instanceId, workspaceId: 'business.work', provider: { pluginId: 'business', viewId } });
  }
  ui.writeLayout('business.work', layout);
  const pool = createMountPool(ui, document, lifetime.signal);
  const unavailable = async (): Promise<never> => { throw new Error('响应式单元不发业务请求'); };
  const context: HostContext = {
    apiVersion: 2, signal: lifetime.signal, ui,
    listOperations: async () => ({ data: [], logId: null }),
    submit: unavailable, getJob: unavailable, cancelJob: unavailable,
    subscribeOperations: () => () => {}, onDispose: (release) => release,
  };
  const controller = createShellController(context, pool, '/example');
  return {
    root, target, window, document, ui, pool, context, controller, mounted, released,
    async render() { await act(async () => { root.render(createElement(Shell, { context, controller, pool })); }); },
    async resize(nextWidth: number) {
      width = nextWidth;
      await act(async () => { for (const measure of [...measurements]) measure(); });
    },
    async resizeCanvas(nextWidth: number, nextHeight: number) {
      canvasWidth = nextWidth; canvasHeight = nextHeight;
      await act(async () => { for (const measure of [...measurements]) measure(); });
    },
    async close() {
      await act(async () => { root.unmount(); });
      controller.dispose();
      await pool.dispose();
      lifetime.abort();
      registry.dispose();
      browser.window.close();
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

test('恢复原64/236导航且以实际容器1100断点响应，隐藏不翻转密度', async () => {
  const f = await fixture(940);
  try {
    await f.render();
    const shell = f.target.firstElementChild;
    assert.ok(shell);
    assert.equal(f.window.innerWidth, 1424);
    assert.equal(f.controller.snapshot().compact, true);
    classes(shell, ['grid-cols-[64px_minmax(0,1fr)]']);
    assert.equal([...shell.querySelectorAll('*'), shell].some((element) =>
      element.getAttribute('class')?.includes('max-[1100px]')), false);
    assert.equal(shell.querySelector('aside')?.textContent?.includes('设备工坊 DeviceForge'), false);
    await f.resize(1099);
    classes(shell, ['grid-cols-[64px_minmax(0,1fr)]']);
    await f.resize(0);
    assert.equal(f.controller.snapshot().compact, true);
    await f.resize(1100);
    assert.equal(f.controller.snapshot().compact, false);
    classes(shell, ['grid-cols-[236px_minmax(0,1fr)]']);
    assert.equal(shell.querySelector('aside')?.textContent?.includes('设备工坊 DeviceForge'), true);
    Object.defineProperty(f.window, 'innerWidth', { configurable: true, value: 800 });
    await f.resize(1424);
    assert.equal(f.controller.snapshot().compact, false);
    classes(shell, ['grid-cols-[236px_minmax(0,1fr)]']);
  } finally { await f.close(); }
});

test('容器缩窄隐藏及切换视图保留原草稿DOM，不重挂业务且不改持久布局', async () => {
  const f = await fixture();
  try {
    await f.render();
    const first = f.target.querySelector<HTMLInputElement>('input[aria-label="草稿 deviceforge_shell.one"]');
    const second = f.target.querySelector<HTMLInputElement>('input[aria-label="草稿 deviceforge_shell.two"]');
    assert.ok(first && second);
    first.value = '第一份未保存草稿'; second.value = '第二份未保存草稿';
    const before = JSON.stringify(f.ui.readLayout('business.work'));
    await f.resize(940);
    assert.ok(f.target.contains(first));
    assert.equal(f.target.contains(second), false);
    await act(async () => { f.controller.selectCompact('deviceforge_shell.two'); });
    assert.ok(f.target.contains(second));
    assert.equal(f.target.contains(first), false);
    await f.resize(1424);
    assert.ok(f.target.contains(first) && f.target.contains(second));
    assert.equal(first.value, '第一份未保存草稿');
    assert.equal(second.value, '第二份未保存草稿');
    assert.deepEqual([...f.mounted.values()], [1, 1]);
    assert.equal(f.released.size, 0);
    assert.equal(JSON.stringify(f.ui.readLayout('business.work')), before);
  } finally { await f.close(); }
});

test('底栏插件按内容流式展开而非固定八格高或六十四格宽，挂载仍由原池管理', async () => {
  const f = await fixture(), registry = createPointRegistry();
  try {
    f.ui.register({ views: [{ id: 'deviceforge_shell.footer_probe', title: '底栏状态', mount: async () => () => {} }] });
    const points = registry.access({ pluginId: 'deviceforge_shell', generation: 1, signal: f.context.signal, track: (release) => release });
    const ref = { id: 'deviceforge_shell.footer', version: '1' };
    points.define({ ...ref, title: '底部状态', modes: ['append'] });
    points.contribute({ id: 'deviceforge_shell.footer_probe.entry', point: ref,
      data: { pluginId: 'deviceforge_shell', viewId: 'deviceforge_shell.footer_probe' }, mode: 'append' });
    const context: HostContext = { ...f.context, extensions: {
      points, catalog: () => ({ components: [], commands: [], modules: [], services: [] }),
      executeCommand: async () => ({ data: null, logId: null }), callService: async () => ({ data: null, logId: null }),
      subscribeEvent: () => () => {}, emitEvent() {}, getState: () => undefined, setState() {}, subscribeState: () => () => {},
    } };
    await act(async () => { f.root.render(createElement(Shell, { context, controller: f.controller, pool: f.pool })); });
    const wrapper = f.target.querySelector('[aria-label="扩展来源 deviceforge_shell"]'); assert.ok(wrapper);
    const mount = wrapper.lastElementChild;
    classes(mount, ['min-h-0', 'min-w-0']);
    for (const fixed of ['h-8', 'max-w-64', 'overflow-auto']) assert.equal(mount?.classList.contains(fixed), false);
    assert.equal(mount?.querySelectorAll('input').length, 1);
  } finally { await f.close(); registry.dispose(); }
});

test('外壳头尾按内容换行，嵌套页签和分栏贯通可收缩高度链并在内部滚动', async () => {
  assert.ok(split.root);
  const layout: WorkspaceLayout = {
    ...split, root: { kind: 'tabs', active: 'main', items: [{ id: 'main', title: '组合视图', node: split.root }] },
  };
  const f = await fixture(1424, layout);
  try {
    await f.render();
    const shell = f.target.firstElementChild;
    assert.ok(shell);
    classes(shell, ['grid-rows-[auto_minmax(0,1fr)_auto_auto]', 'overflow-hidden']);
    classes(shell.querySelector(':scope > header'), ['min-h-[54px]', 'min-w-0', 'flex-wrap']);
    classes(shell.querySelector(':scope > footer'), ['min-h-[26px]', 'min-w-0', 'flex-wrap']);
    const main = shell.querySelector('main');
    classes(main, ['flex', 'flex-col', 'min-h-0', 'min-w-0', 'overflow-hidden']);
    assert.equal(main?.querySelector('[title="页面来自 business"]'), null);
    assert.equal(main?.querySelector('h1'), null);
    const canvas = main?.querySelector('[data-workspace-canvas]');
    classes(canvas ?? null, ['min-h-0', 'min-w-0', 'flex-1']);
    assert.equal(canvas?.classList.contains('min-h-[520px]'), false);
    const tabs = canvas?.firstElementChild;
    classes(tabs ?? null, ['h-full', 'flex', 'flex-col', 'min-h-0', 'min-w-0']);
    classes(tabs?.querySelector('[role="tablist"]') ?? null, ['shrink-0', 'min-w-0', 'overflow-x-auto']);
    const active = tabs?.lastElementChild;
    classes(active ?? null, ['flex-1', 'min-h-0', 'min-w-0']);
    classes(active?.firstElementChild ?? null, ['h-full', 'flex', 'flex-col', 'min-h-0', 'min-w-0']);
    classes(active?.querySelector('[style*="--shell-cols"]') ?? null, ['grid', 'flex-1', 'min-h-0', 'min-w-0']);
    for (const frame of shell.querySelectorAll('[data-shell-instance]')) {
      classes(frame, ['h-full', 'min-h-0', 'min-w-0', 'overflow-hidden']);
      assert.equal(frame.querySelector('header'), null);
      classes(frame.lastElementChild, ['h-full', 'min-h-0', 'min-w-0']);
    }
    await f.resize(940);
    assert.equal(shell.textContent?.includes('更换外壳'), false);
  } finally { await f.close(); }
});

test('默认界面自动呈现插件业务，不暴露用户搭建入口且原专注与导航操作仍可用', async () => {
  const f = await fixture(1424);
  try {
    await f.render();
    for (const label of ['添加功能', '编辑布局', '停靠到', '关闭视图', '更换提供者', '更换外壳', '页面来自']) {
      assert.equal(f.target.textContent?.includes(label), false, `普通界面不应出现 ${label}`);
    }
    assert.equal(f.target.querySelectorAll('main input').length, 2);
    assert.equal(f.mounted.size, 2);
    const collapse = f.target.querySelector<HTMLButtonElement>('[aria-label="折叠侧边导航"]');
    assert.ok(collapse);
    await act(async () => collapse.click());
    classes(f.target.firstElementChild, ['grid-cols-[64px_minmax(0,1fr)]']);
    const navigation = f.target.querySelector('aside');
    await act(async () => namedButton(f.target, '专注').click());
    assert.equal(f.target.querySelector('aside'), navigation);
    assert.equal(navigation?.hidden, true);
    assert.equal(f.target.querySelectorAll('main input').length, 2);
    await act(async () => namedButton(f.target, '退出专注').click());
    assert.equal(navigation?.hidden, false);
    assert.equal(f.released.size, 0);
  } finally { await f.close(); }
});

test('外壳只管理布局直接节点，不覆写业务父视图拥有的嵌套子实例可见性', async () => {
  const f = await fixture(1424);
  try {
    await f.render();
    const id = 'deviceforge_shell.nested-child';
    await act(async () => {
      f.ui.open({ instanceId: id, workspaceId: 'business.work',
        provider: { pluginId: 'business', viewId: 'business.one' }, visible: true });
      assert.equal(f.ui.snapshot().instances.find((entry) => entry.instanceId === id)?.visible, true);
      f.controller.setCompact(true);
      assert.equal(f.ui.snapshot().instances.find((entry) => entry.instanceId === id)?.visible, true);
      f.ui.setVisible(id, false);
      f.controller.setCompact(false);
      assert.equal(f.ui.snapshot().instances.find((entry) => entry.instanceId === id)?.visible, false);
      f.ui.setVisible(id, true);
      assert.equal(f.ui.snapshot().instances.find((entry) => entry.instanceId === id)?.visible, true);
    });
  } finally { await f.close(); }
});

test('窄容器保留插件自定义布局提供者及其草稿，不拆成宿主通用功能页签', async () => {
  const custom: WorkspaceLayout['root'] = {
    kind: 'custom', provider: { pluginId: 'business', viewId: 'business.one' },
    data: { mode: 'responsive' },
    children: [{ kind: 'view', instanceId: 'deviceforge_shell.one' }],
  };
  const second = { kind: 'view', instanceId: 'deviceforge_shell.two' } as const;
  const layouts: readonly WorkspaceLayout[] = [
    { version: 1, root: custom,
      floating: [{ instanceId: 'deviceforge_shell.two', x: 15, y: 20, width: 260, height: 180, z: 1 }], overlays: [] },
    { version: 1, root: { kind: 'tabs', active: 'custom', items: [
      { id: 'custom', title: '插件组合', node: custom }, { id: 'other', title: '其他', node: second },
    ] }, floating: [], overlays: [] },
    { version: 1, root: { kind: 'split', direction: 'horizontal', weights: [1, 1],
      children: [custom, second] }, floating: [], overlays: [] },
  ];
  for (const [at, layout] of layouts.entries()) {
    const f = await fixture(940, layout);
    try {
      await f.render();
      assert.equal(f.controller.snapshot().compact, true, `布局${at}仍须使用窄导航`);
      const current = f.ui.snapshot().instances.find((entry) => entry.instanceId.startsWith('deviceforge_shell.custom.'));
      assert.ok(current, `布局${at}不能绕过插件自定义布局提供者`);
      assert.equal(current.visible, true);
      const input = f.target.querySelector<HTMLInputElement>(`input[aria-label="草稿 ${current.instanceId}"]`);
      assert.ok(input);
      input.value = `插件草稿${at}`;
      assert.equal(f.target.querySelector('[aria-label="当前页面功能"]'), null);
      assert.equal(f.mounted.has('deviceforge_shell.one'), false, '子视图由自定义提供者组织，不能被外壳直接顶替');
      await act(async () => { f.ui.setVisible('deviceforge_shell.one', false); });
      assert.equal(f.ui.snapshot().instances.find((entry) => entry.instanceId === 'deviceforge_shell.one')?.visible,
        false, '自定义提供者的子视图可见性不能被外壳刷新覆写');
      if (at === 0)
        assert.ok(f.target.querySelector('[aria-label="草稿 deviceforge_shell.two"]'), '插件声明的浮窗不能随窄导航丢失');
      const stored = JSON.stringify(f.ui.readLayout('business.work'));
      await f.resize(1424);
      await f.resize(640);
      assert.equal(f.target.querySelector(`[aria-label="草稿 ${current.instanceId}"]`), input);
      assert.equal(input.value, `插件草稿${at}`);
      assert.equal(f.mounted.get(current.instanceId), 1);
      assert.equal(f.released.size, 0);
      assert.equal(f.ui.snapshot().instances.find((entry) => entry.instanceId === 'deviceforge_shell.one')?.visible,
        false, '容器变化仍由自定义提供者管理其子视图');
      assert.equal(JSON.stringify(f.ui.readLayout('business.work')), stored);
    } finally { await f.close(); }
  }
});

test('插件更换同一自定义布局位置的提供者时显示当前提供者，不残留旧根或影响其他草稿', async () => {
  const custom: WorkspaceLayout['root'] = {
    kind: 'custom', provider: { pluginId: 'business', viewId: 'business.one' },
    data: { mode: 'first' }, children: [{ kind: 'view', instanceId: 'deviceforge_shell.one' }],
  };
  const layout: WorkspaceLayout = {
    version: 1, root: custom,
    floating: [{ instanceId: 'deviceforge_shell.two', x: 15, y: 20, width: 260, height: 180, z: 1 }],
    overlays: [],
  };
  const f = await fixture(940, layout);
  try {
    await f.render();
    const original = f.ui.snapshot().instances.find((entry) => entry.instanceId.startsWith('deviceforge_shell.custom.'));
    assert.ok(original);
    const input = f.target.querySelector<HTMLInputElement>(`input[aria-label="草稿 ${original.instanceId}"]`);
    const unrelated = f.target.querySelector<HTMLInputElement>('input[aria-label="草稿 deviceforge_shell.two"]');
    assert.ok(input && unrelated);
    unrelated.value = '无关浮窗的未保存草稿';
    const next: WorkspaceLayout = { ...layout, root: {
      ...custom, provider: { pluginId: 'business', viewId: 'business.two' }, data: { mode: 'second' },
    } };
    await act(async () => { f.ui.writeLayout('business.work', next); });
    const changed = f.ui.snapshot().instances.find((entry) => entry.instanceId === original.instanceId);
    assert.deepEqual(changed?.provider, { pluginId: 'business', viewId: 'business.two' },
      '同一布局位置的运行实例必须消费当前插件声明，不能仍挂旧提供者');
    assert.ok(changed && changed.generation > original.generation);
    assert.deepEqual(changed.target, { data: { mode: 'second' }, children: custom.children });
    assert.equal(f.target.contains(input), false);
    assert.equal(f.target.querySelectorAll(`input[aria-label="草稿 ${original.instanceId}"]`).length, 1);
    assert.equal(f.mounted.get(original.instanceId), 2);
    assert.equal(f.released.get(original.instanceId), 1);
    assert.equal(f.target.querySelector('input[aria-label="草稿 deviceforge_shell.two"]'), unrelated);
    assert.equal(unrelated.value, '无关浮窗的未保存草稿');
    const generation = changed.generation;
    await act(async () => { f.controller.ensureCustom('business.work', '', {
      ...custom, provider: { pluginId: 'business', viewId: 'business.two' }, data: { mode: 'second' },
    }); });
    assert.equal(f.ui.snapshot().instances.find((entry) => entry.instanceId === original.instanceId)?.generation, generation);
    assert.equal(f.mounted.get(original.instanceId), 2, '相同声明不重复挂载');
    const missing: WorkspaceLayout = { ...layout, root: {
      ...custom, provider: { pluginId: 'waiting_provider', viewId: 'waiting_provider.layout' },
    } };
    await act(async () => { f.ui.writeLayout('business.work', missing); });
    const pending = f.ui.snapshot().instances.find((entry) => entry.instanceId === original.instanceId);
    assert.deepEqual(pending?.provider, { pluginId: 'waiting_provider', viewId: 'waiting_provider.layout' });
    assert.equal(pending?.reason, 'provider_missing');
    assert.equal(f.target.querySelector(`input[aria-label="草稿 ${original.instanceId}"]`), null,
      '当前提供者缺失时不能用旧界面冒充当前声明');
    assert.equal(f.target.querySelector('input[aria-label="草稿 deviceforge_shell.two"]'), unrelated);
    await act(async () => { f.ui.writeLayout('business.work', next); });
    assert.equal(f.target.querySelectorAll(`input[aria-label="草稿 ${original.instanceId}"]`).length, 1);
    assert.equal(unrelated.value, '无关浮窗的未保存草稿');
    assert.equal(f.mounted.get('deviceforge_shell.two'), 1);
    assert.equal(f.released.has('deviceforge_shell.two'), false);
    assert.equal(f.target.querySelector('[aria-label="当前页面功能"]'), null);
  } finally { await f.close(); }
});
