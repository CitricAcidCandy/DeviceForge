import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import type { TestContext } from 'node:test';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import type { Dispose, HostContext, UiAccess } from '../src/plugin-sdk/index.ts';
import { createWorkspaceRegistry } from '../src/plugins/workspace/index.ts';
import { createPointRegistry } from '../src/plugins/points/registry.ts';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';

// 标准Sheet首次导入前建立DOM，确保Radix使用浏览器布局效果及真实Portal。
const browser = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://127.0.0.1:7031/#/devices', pretendToBeVisual: true,
});
const window = browser.window, document = window.document;
Object.defineProperty(window, 'innerWidth', { configurable: true, value: 2237 });
const saved = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window, document, navigator: window.navigator, Element: window.Element, HTMLElement: window.HTMLElement,
  Document: window.Document, DocumentFragment: window.DocumentFragment, Node: window.Node,
  HTMLInputElement: window.HTMLInputElement, HTMLButtonElement: window.HTMLButtonElement,
  HTMLSelectElement: window.HTMLSelectElement, HTMLTextAreaElement: window.HTMLTextAreaElement,
  HTMLFormElement: window.HTMLFormElement, NodeFilter: window.NodeFilter, MutationObserver: window.MutationObserver,
  Event: window.Event, CustomEvent: window.CustomEvent, MouseEvent: window.MouseEvent,
  KeyboardEvent: window.KeyboardEvent, FocusEvent: window.FocusEvent,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window), IS_REACT_ACT_ENVIRONMENT: true,
})) {
  saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
const parser = registerCompositionStartupImports();
assert.deepEqual(parser.diagnostics, []);
const { installPublicUi } = await import('../src/app/public-ui.ts');
const { hostUi } = await import('../src/plugin-sdk/index.ts');
const { resolveOwnedPortalRoot } = await import('../src/app/portal-ownership.ts');
const { mountShell } = await import('../plugins/default-shell/src/mount.tsx');
const releaseUi = installPublicUi();
after(async () => {
  await act(async () => {});
  await new Promise<void>((resolve) => setImmediate(resolve));
  await releaseUi(); parser.dispose(); browser.window.close();
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

type Page = 'devices' | 'files';
const pages = { devices: { title: '设备', group: '工作台' }, files: { title: '文件', group: '深度调试' } };
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function fixture(unit: TestContext, initialWidth: number) {
  window.history.replaceState(null, '', '#/devices');
  const target = document.createElement('section');
  target.dataset.deviceforgePlugin = 'deviceforge_shell';
  target.dataset.deviceforgeGeneration = '65';
  target.dataset.deviceforgeExtension = 'workspace.deviceforge_shell.main.65';
  document.body.append(target);
  let width = initialWidth;
  const measurements = new Set<() => void>();
  const priorWidth = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'clientWidth');
  const priorObserver = Object.getOwnPropertyDescriptor(window, 'ResizeObserver');
  Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', {
    configurable: true, get(this: HTMLElement) {
      return this.hasAttribute('data-navigation-collapsed') || this.hasAttribute('data-navigation-mobile') ? width : 0;
    },
  });
  Object.defineProperty(window, 'ResizeObserver', { configurable: true, value: class {
    readonly callback: () => void;
    constructor(callback: () => void) { this.callback = callback; }
    observe() { measurements.add(this.callback); }
    disconnect() { measurements.delete(this.callback); }
  } });
  unit.mock.method(globalThis, 'fetch', async () => { throw new Error('窄窗导航单元禁止真实网络'); });
  const owner = new AbortController(), registry = createWorkspaceRegistry(), points = createPointRegistry();
  const finalizers = new Set<Dispose>();
  const mounted: Record<Page, number> = { devices: 0, files: 0 }, unmounted: Record<Page, number> = { devices: 0, files: 0 };
  const access = registry.access({ pluginId: 'deviceforge_shell', generation: 65, signal: owner.signal });
  const forbidden = async (): Promise<never> => { throw new Error('导航单元不得执行设备或业务请求'); };
  const ui: UiAccess = { ...access, async mount(instanceId, root, signal) {
    signal.throwIfAborted();
    const snapshot = () => {
      const current = access.snapshot().instances.find((entry) => entry.instanceId === instanceId);
      assert.ok(current); return current;
    };
    const provider = snapshot().provider; assert.ok(provider);
    const page = registry.resolvePage(provider.viewId); assert.ok(page?.definition.mount);
    return page.definition.mount(root, context, {
      signal, snapshot, subscribeVisibility: (listener) => access.subscribe(() => listener(snapshot().visible)),
    });
  } };
  const context: HostContext = {
    apiVersion: 2, signal: owner.signal, ui,
    listOperations: async () => ({ data: [], logId: null }), submit: forbidden, getJob: forbidden, cancelJob: forbidden,
    subscribeOperations: () => () => {}, onDispose(release) {
      finalizers.add(release); return () => { finalizers.delete(release); return release(); };
    },
    extensions: {
      points: points.access({ pluginId: 'deviceforge_shell', generation: 65, signal: owner.signal, track: (release) => release }),
      catalog: () => ({ components: [], modules: [], commands: [], services: [] }),
      executeCommand: forbidden, callService: forbidden, subscribeEvent: () => () => {}, emitEvent() {},
      getState: () => undefined, setState() {}, subscribeState: () => () => {},
    },
  };
  for (const page of ['devices', 'files'] as const) {
    registry.access({ pluginId: `navigation_${page}`, generation: 1, signal: owner.signal }).register({
      pages: [{ id: `navigation_${page}.main`, title: pages[page].title, route: `/${page}`,
        navigation: { group: pages[page].group, order: page === 'devices' ? 10 : 20 },
        async mount(root, _context, instance) {
          instance.signal.throwIfAborted(); mounted[page]++;
          const release = hostUi().mountReact(root, createElement('input', {
            'aria-label': `${pages[page].title}草稿`, 'data-page-draft': page, defaultValue: '初始草稿',
          }));
          return () => { unmounted[page]++; return release(); };
        },
      }],
    });
  }
  let releaseShell: Dispose = () => {}, shellClosed = false;
  async function closeShell() {
    if (shellClosed) return;
    shellClosed = true;
    await act(async () => { await releaseShell(); await settle(); });
  }
  unit.after(async () => {
    try {
      await closeShell(); owner.abort();
      for (const release of [...finalizers]) await release();
      points.dispose(); registry.dispose();
    } finally {
      target.remove();
      if (priorWidth) Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', priorWidth);
      else Reflect.deleteProperty(window.HTMLElement.prototype, 'clientWidth');
      if (priorObserver) Object.defineProperty(window, 'ResizeObserver', priorObserver);
      else Reflect.deleteProperty(window, 'ResizeObserver');
    }
  });
  await act(async () => { releaseShell = await mountShell(target, context); await settle(); });
  function input(page: Page) {
    const input = target.querySelector<HTMLInputElement>(`[data-product-workspace] input[data-page-draft="${page}"]`);
    assert.ok(input, `当前${pages[page].title}应经真实页面挂载显示`); return input;
  }
  function shell() {
    const root = target.querySelector<HTMLElement>('[data-navigation-collapsed]'); assert.ok(root); return root;
  }
  return { target, input, shell, mounted, unmounted, measurements, closeShell,
    async resize(nextWidth: number) {
      width = nextWidth;
      await act(async () => { for (const measure of [...measurements]) measure(); await settle(); });
    },
  };
}

function openButton(root: ParentNode) {
  const button = root.querySelector<HTMLButtonElement>('button[aria-label="打开导航"]');
  assert.ok(button, '实际容器<=900px时应提供原导航抽屉入口，而非保留64px常驻侧栏'); return button;
}
function sheet() {
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]'); assert.ok(dialog, '导航应使用真实标准Sheet'); return dialog;
}
async function click(button: HTMLButtonElement) {
  await act(async () => { button.click(); await settle(); });
}
function routeButton(root: ParentNode, page: Page) {
  const button = root.querySelector<HTMLButtonElement>(`nav[aria-label="工作区导航"] button[title="${pages[page].title}"]`);
  assert.ok(button, '抽屉应复用原分组导航的真实页面目录'); return button;
}

test('480px实际容器使用导航抽屉，Escape返焦点和路由往返均保留业务草稿', async (unit) => {
  const f = await fixture(unit, 480);
  assert.equal(window.innerWidth, 2237, '测试不能借浏览器窗口宽度冒充真实工作区容器');
  const draft = f.input('devices'); draft.value = '设备页未提交草稿';
  assert.ok(f.target.querySelector('aside[aria-label="主导航区域"]') === null, '关闭抽屉时窄区不保留常驻导航');
  const trigger = openButton(f.target); trigger.focus(); await click(trigger);
  const dialog = sheet();
  assert.equal(f.target.contains(dialog), false, '标准Sheet经Portal呈现，不占据业务内容位置');
  assert.equal(dialog.querySelector('[data-slot="sheet-title"]')?.textContent, '工坊导航');
  assert.equal(dialog.querySelector('[data-slot="sheet-description"]')?.textContent, '选择工具，继续当前设备工作');
  assert.match(dialog.textContent ?? '', /工作台/); assert.match(dialog.textContent ?? '', /深度调试/);
  assert.equal(routeButton(dialog, 'devices').getAttribute('aria-current'), 'page');
  assert.ok(routeButton(dialog, 'files'));
  await act(async () => {
    (document.activeElement ?? dialog).dispatchEvent(new window.KeyboardEvent('keydown', {
      key: 'Escape', code: 'Escape', bubbles: true, cancelable: true,
    }));
    await settle();
  });
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.equal(document.activeElement, trigger);
  assert.equal(f.input('devices'), draft);
  await click(trigger); await click(routeButton(sheet(), 'files'));
  assert.equal(document.querySelector('[role="dialog"]'), null, '选页后关闭抽屉');
  assert.equal(window.location.hash, '#/files');
  const filesDraft = f.input('files'); filesDraft.value = '文件页未提交草稿';
  await click(openButton(f.target)); await click(routeButton(sheet(), 'devices'));
  assert.equal(f.input('devices'), draft); assert.equal(draft.value, '设备页未提交草稿');
  await click(openButton(f.target)); await click(routeButton(sheet(), 'files'));
  assert.equal(f.input('files'), filesDraft); assert.equal(filesDraft.value, '文件页未提交草稿');
  assert.deepEqual(f.mounted, { devices: 1, files: 1 });
  assert.deepEqual(f.unmounted, { devices: 0, files: 0 });
});

test('初始零宽不启用抽屉，窄宽切换和卸载撤销Portal且保留桌面折叠偏好', async (unit) => {
  const f = await fixture(unit, 0);
  assert.equal(f.target.querySelector('button[aria-label="打开导航"]'), null, '首次无尺寸不猜测移动模式');
  const draft = f.input('devices'); draft.value = '尺寸变化保留此草稿';
  await f.resize(1424);
  const collapse = f.target.querySelector<HTMLButtonElement>('button[aria-label="折叠侧边导航"]'); assert.ok(collapse);
  await click(collapse);
  assert.equal(f.shell().getAttribute('data-navigation-collapsed'), 'true');
  await f.resize(0);
  assert.equal(f.target.querySelector('button[aria-label="打开导航"]'), null);
  assert.ok(f.target.querySelector('button[aria-label="展开侧边导航"]'), '无尺寸观测不丢手动折叠偏好');
  await f.resize(900);
  await click(openButton(f.target));
  const dialog = sheet();
  assert.equal(resolveOwnedPortalRoot(dialog)?.anchor, f.target, '真实公开UI桥应将抽屉归属当前外壳实例');
  assert.equal(dialog.hasAttribute('data-deviceforge-portal'), true);
  await f.resize(0);
  assert.equal(document.querySelector('[role="dialog"]'), dialog, '已打开抽屉不因隐藏测得零宽而切换');
  await f.resize(940);
  assert.equal(document.querySelector('[role="dialog"]'), null, '宽区恢复常驻导航时关闭抽屉');
  assert.equal(dialog.isConnected, false);
  assert.equal(resolveOwnedPortalRoot(dialog), null);
  assert.equal(dialog.hasAttribute('data-deviceforge-portal'), false);
  assert.ok(f.target.querySelector('button[aria-label="展开侧边导航"]'), '从移动区返回保留原手动折叠');
  const expand = f.target.querySelector<HTMLButtonElement>('button[aria-label="展开侧边导航"]'); assert.ok(expand);
  await click(expand);
  assert.equal(f.shell().getAttribute('data-navigation-collapsed'), 'false');
  await f.resize(1424);
  assert.equal(f.shell().getAttribute('data-navigation-collapsed'), 'false');
  assert.equal(f.input('devices'), draft); assert.equal(draft.value, '尺寸变化保留此草稿');
  await f.resize(480);
  assert.equal(document.querySelector('[role="dialog"]'), null, '再次进入窄区不自动重开导航');
  await click(openButton(f.target));
  const finalDialog = sheet();
  assert.equal(resolveOwnedPortalRoot(finalDialog)?.anchor, f.target);
  assert.equal(f.input('devices'), draft);
  assert.deepEqual(f.mounted, { devices: 1, files: 0 });
  assert.deepEqual(f.unmounted, { devices: 0, files: 0 });
  await f.closeShell();
  assert.equal(finalDialog.isConnected, false);
  assert.equal(resolveOwnedPortalRoot(finalDialog), null);
  assert.equal(finalDialog.hasAttribute('data-deviceforge-portal'), false);
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.equal(f.measurements.size, 0, '退出实例必须断开尺寸订阅');
  assert.deepEqual(f.unmounted, { devices: 1, files: 0 });
});
