import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { act, createElement, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { JSDOM } from 'jsdom';
import type { Dispose } from '../src/plugin-sdk/index.ts';
import type { ShellState } from '../plugins/default-shell/src/controller.ts';
import { createWorkspaceRegistry } from '../src/plugins/workspace/index.ts';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';

// Radix首次导入前提供DOM环境，避免把服务端布局模式缓存到真实Portal单元中。
const browser = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://127.0.0.1:7031/#/devices', pretendToBeVisual: true,
});
const document = browser.window.document;
const saved = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser.window, document, navigator: browser.window.navigator,
  Element: browser.window.Element, HTMLElement: browser.window.HTMLElement, Document: browser.window.Document,
  HTMLInputElement: browser.window.HTMLInputElement, HTMLButtonElement: browser.window.HTMLButtonElement,
  HTMLSelectElement: browser.window.HTMLSelectElement, HTMLTextAreaElement: browser.window.HTMLTextAreaElement,
  HTMLFormElement: browser.window.HTMLFormElement, DocumentFragment: browser.window.DocumentFragment,
  Node: browser.window.Node, NodeFilter: browser.window.NodeFilter, MutationObserver: browser.window.MutationObserver,
  Event: browser.window.Event, CustomEvent: browser.window.CustomEvent, MouseEvent: browser.window.MouseEvent,
  KeyboardEvent: browser.window.KeyboardEvent, FocusEvent: browser.window.FocusEvent,
  getComputedStyle: browser.window.getComputedStyle.bind(browser.window),
  requestAnimationFrame: browser.window.requestAnimationFrame.bind(browser.window),
  cancelAnimationFrame: browser.window.cancelAnimationFrame.bind(browser.window), IS_REACT_ACT_ENVIRONMENT: true,
})) {
  saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
const imports = registerCompositionStartupImports();
const { installPublicUi } = await import('../src/app/public-ui.ts');
const { hostUi } = await import('../src/plugin-sdk/index.ts');
const { resolveOwnedPortalRoot } = await import('../src/app/portal-ownership.ts');
const { ShellHeader } = await import('../plugins/default-shell/src/chrome.tsx');
const releaseUi = installPublicUi();
const registry = createWorkspaceRegistry();
const state: ShellState = {
  model: registry.snapshot(), pages: [], routeConflicts: [], visited: [], route: '/devices', current: null,
  available: true, compact: false, compactView: null, notice: null, preparing: 0,
};
after(async () => {
  await act(async () => {});
  await new Promise<void>((resolve) => setImmediate(resolve));
  await releaseUi(); registry.dispose(); imports.dispose(); browser.window.close();
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  }
});

function anchor(pluginId = 'deviceforge_shell') {
  const root = document.createElement('section');
  root.dataset.deviceforgePlugin = pluginId;
  root.dataset.deviceforgeGeneration = '13';
  root.dataset.deviceforgeExtension = `workspace.${pluginId}.main.4`;
  document.body.append(root);
  return root;
}
async function mount(root: HTMLElement, element: ReactElement) {
  let release: Dispose = () => {};
  await act(async () => { release = hostUi().mountReact(root, element); });
  return async () => { await act(async () => { await release(); }); };
}
async function key(element: Element, name: string) {
  await act(async () => {
    element.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: name, code: name, bubbles: true, cancelable: true }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}
function trigger(root: ParentNode) {
  const button = root.querySelector<HTMLButtonElement>('button[aria-label="更多设置"]');
  assert.ok(button, '顶栏更多设置应恢复标准菜单按钮，不能继续使用details/summary');
  return button;
}
function menu() {
  const content = document.querySelector<HTMLElement>('[role="menu"]');
  assert.ok(content, '更多设置应打开具有标准菜单语义的弹层');
  return content;
}
function Header({ navigate, onReduced, reduced = false }: {
  readonly navigate: (route: string) => void; readonly onReduced: () => void; readonly reduced?: boolean;
}) {
  return createElement(ShellHeader, { state, compact: false, focused: false, reduced,
    connection: { state: 'connected', text: '服务器已连接', logId: null, error: null },
    onCollapse() {}, onFocus() {}, onRefresh() {}, navigate, onReduced });
}

test('顶栏更多设置支持键盘选择主题和减少动态效果，Escape归还焦点且不重挂业务草稿', async () => {
  const root = anchor(), routes: string[] = [];
  let mounted = 0, unmounted = 0, reducedCalls = 0;
  function Draft() {
    useEffect(() => { mounted++; return () => { unmounted++; }; }, []);
    return createElement('input', { 'aria-label': '业务草稿', defaultValue: '保留原草稿' });
  }
  function Screen() {
    const [reduced, setReduced] = useState(false);
    return createElement('div', null, createElement(Header, { reduced,
      navigate: (route) => { routes.push(route); },
      onReduced: () => { reducedCalls++; setReduced((value) => !value); },
    }), createElement(Draft));
  }
  const release = await mount(root, createElement(Screen));
  try {
    const draft = root.querySelector<HTMLInputElement>('input[aria-label="业务草稿"]'); assert.ok(draft);
    draft.value = '编辑中的业务草稿';
    const button = trigger(root); button.focus();
    await key(button, 'ArrowDown');
    assert.equal(button.getAttribute('aria-expanded'), 'true');
    assert.ok(menu());
    await key(document.activeElement ?? menu(), 'ArrowDown');
    await key(document.activeElement ?? menu(), 'ArrowDown');
    assert.match(document.activeElement?.textContent ?? '', /主题与设置/);
    await key(document.activeElement ?? menu(), 'Enter');
    assert.deepEqual(routes, ['/settings']);
    assert.equal(document.querySelector('[role="menu"]'), null);

    await key(button, 'ArrowDown');
    await key(document.activeElement ?? menu(), 'ArrowDown');
    assert.match(document.activeElement?.textContent ?? '', /减少动态效果/);
    await key(document.activeElement ?? menu(), 'Enter');
    assert.equal(reducedCalls, 1);
    await key(button, 'ArrowDown');
    const checkbox = menu().querySelector('[role="menuitemcheckbox"]');
    assert.equal(checkbox?.getAttribute('aria-checked'), 'true');
    await key(document.activeElement ?? menu(), 'Escape');
    assert.equal(document.querySelector('[role="menu"]'), null);
    assert.equal(document.activeElement, button);
    assert.equal(root.querySelector('input[aria-label="业务草稿"]'), draft);
    assert.equal(draft.value, '编辑中的业务草稿');
    assert.equal(mounted, 1); assert.equal(unmounted, 0);
  } finally { await release(); root.remove(); }
});

test('真实公开mountReact子挂载拥有菜单Portal，卸载撤销弹层且父业务草稿保留', async () => {
  const parent = anchor('parent_business');
  const releaseParent = await mount(parent, createElement('div', null,
    createElement('input', { 'aria-label': '父业务草稿', defaultValue: '父实例草稿' }),
    createElement('div', { 'data-testid': 'shell-child' })));
  const child = parent.querySelector<HTMLElement>('[data-testid="shell-child"]'); assert.ok(child);
  child.dataset.deviceforgePlugin = 'deviceforge_shell';
  child.dataset.deviceforgeGeneration = '13';
  child.dataset.deviceforgeExtension = 'workspace.deviceforge_shell.main.4';
  const releaseChild = await mount(child, createElement(Header, { navigate() {}, onReduced() {} }));
  try {
    const draft = parent.querySelector<HTMLInputElement>('input[aria-label="父业务草稿"]'); assert.ok(draft);
    const button = trigger(child); button.focus(); await key(button, 'ArrowDown');
    const content = menu();
    assert.equal(child.contains(content), false, '菜单应经真实Portal呈现，不挤压或裁切顶栏');
    assert.equal(resolveOwnedPortalRoot(content)?.anchor, child);
    assert.equal(content.getAttribute('data-deviceforge-plugin'), 'deviceforge_shell');
    await releaseChild();
    assert.equal(content.isConnected, false);
    assert.equal(resolveOwnedPortalRoot(content), null);
    assert.equal(content.hasAttribute('data-deviceforge-portal'), false);
    assert.equal(document.querySelector('[role="menu"]'), null);
    assert.equal(parent.querySelector('input[aria-label="父业务草稿"]'), draft);
    assert.equal(draft.value, '父实例草稿');
  } finally { await releaseChild(); await releaseParent(); parent.remove(); }
});
