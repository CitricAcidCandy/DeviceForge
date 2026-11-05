import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { act, createElement, useEffect } from 'react';
import { JSDOM } from 'jsdom';
import type { Dispose } from '../src/plugin-sdk/index.ts';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';

// 首次导入Radix前提供DOM，验证真实键盘、Portal和公开挂载归属。
const page = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://127.0.0.1:7031/#/terminal', pretendToBeVisual: true,
});
const document = page.window.document;
const saved = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: page.window, document, navigator: page.window.navigator,
  Element: page.window.Element, HTMLElement: page.window.HTMLElement, Document: page.window.Document,
  HTMLInputElement: page.window.HTMLInputElement, HTMLButtonElement: page.window.HTMLButtonElement,
  HTMLSelectElement: page.window.HTMLSelectElement, HTMLTextAreaElement: page.window.HTMLTextAreaElement,
  HTMLFormElement: page.window.HTMLFormElement, DocumentFragment: page.window.DocumentFragment,
  Node: page.window.Node, NodeFilter: page.window.NodeFilter, MutationObserver: page.window.MutationObserver,
  Event: page.window.Event, CustomEvent: page.window.CustomEvent, MouseEvent: page.window.MouseEvent,
  KeyboardEvent: page.window.KeyboardEvent, FocusEvent: page.window.FocusEvent,
  getComputedStyle: page.window.getComputedStyle.bind(page.window),
  requestAnimationFrame: page.window.requestAnimationFrame.bind(page.window),
  cancelAnimationFrame: page.window.cancelAnimationFrame.bind(page.window), IS_REACT_ACT_ENVIRONMENT: true,
})) {
  saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
const imports = registerCompositionStartupImports();
const { installPublicUi } = await import('../src/app/public-ui.ts');
const { hostUi } = await import('../src/plugin-sdk/index.ts');
const { resolveOwnedPortalRoot } = await import('../src/app/portal-ownership.ts');
const releaseUi = installPublicUi();
const { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator } = await import('../plugins/terminal/src/view/DropdownMenu.tsx');
after(async () => {
  await act(async () => {});
  await new Promise<void>((resolve) => setImmediate(resolve));
  await releaseUi(); imports.dispose(); page.window.close();
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  }
});

async function key(element: Element, name: string) {
  await act(async () => {
    element.dispatchEvent(new page.window.KeyboardEvent('keydown', {
      key: name, code: name, bubbles: true, cancelable: true,
    }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}
function menu() {
  const found = document.querySelector<HTMLElement>('[role="menu"]');
  assert.ok(found, '终端操作应通过真实菜单Portal打开'); return found;
}
async function fixture(name: string) {
  const root = document.createElement('section'); document.body.append(root);
  root.dataset.deviceforgePlugin = 'deviceforge_terminal';
  root.dataset.deviceforgeGeneration = '7';
  root.dataset.deviceforgeExtension = `workspace.terminal.${name}.1`;
  const calls = { query: 0, clear: 0, mounted: 0, unmounted: 0 };
  function Draft() {
    useEffect(() => { calls.mounted++; return () => { calls.unmounted++; }; }, []);
    return createElement('input', { 'aria-label': `终端草稿-${name}`, defaultValue: `草稿-${name}` });
  }
  let release: Dispose = () => {};
  try {
    await act(async () => {
      release = hostUi().mountReact(root, createElement('div', null,
        createElement(Draft),
        createElement(DropdownMenu, null,
          createElement(DropdownMenuTrigger, { asChild: true },
            createElement('button', { type: 'button', 'aria-label': '更多会话操作' }, '更多会话操作')),
          createElement(DropdownMenuContent, { align: 'end', className: 'w-52' },
            createElement(DropdownMenuLabel, null, '当前终端'),
            createElement(DropdownMenuItem, { onSelect: () => { calls.query++; } }, '重查会话状态'),
            createElement(DropdownMenuSeparator),
            createElement(DropdownMenuItem, { onSelect: () => { calls.clear++; } }, '清空页面输出')))));
    });
    const trigger = root.querySelector<HTMLButtonElement>('button[aria-label="更多会话操作"]');
    const draft = root.querySelector<HTMLInputElement>('input'); assert.ok(trigger && draft);
    return {
      root, trigger, draft, calls,
      async open() { trigger.focus(); await key(trigger, 'ArrowDown'); return menu(); },
      async release() { await act(async () => { await release(); }); },
      async dispose() { try { await act(async () => { await release(); }); } finally { root.remove(); } },
    };
  } catch (error) {
    try { await act(async () => { await release(); }); } finally { root.remove(); }
    throw error;
  }
}

test('终端菜单键盘选择只执行一次，Escape返原触发器且保留草稿DOM', async () => {
  const f = await fixture('keyboard');
  try {
    f.draft.value = '仍在编辑的终端草稿';
    const content = await f.open();
    assert.equal(f.root.contains(content), false, '终端菜单不应占据终端主区布局');
    assert.match(document.activeElement?.textContent ?? '', /重查会话状态/);
    await key(document.activeElement ?? content, 'ArrowDown');
    assert.match(document.activeElement?.textContent ?? '', /清空页面输出/);
    await key(document.activeElement ?? content, 'Enter');
    assert.equal(f.calls.query, 0); assert.equal(f.calls.clear, 1);
    assert.equal(content.isConnected, false);
    await f.open();
    await key(document.activeElement ?? menu(), 'Escape');
    assert.equal(document.querySelector('[role="menu"]'), null);
    assert.equal(document.activeElement === f.trigger, true, '关闭菜单后归还原触发器焦点');
    assert.equal(f.root.querySelector('input') === f.draft, true);
    assert.equal(f.draft.value, '仍在编辑的终端草稿');
    assert.equal(f.calls.mounted, 1); assert.equal(f.calls.unmounted, 0);
    assert.equal(f.calls.query, 0); assert.equal(f.calls.clear, 1, 'Escape不能重复菜单动作');
  } finally { await f.dispose(); }
});

test('终端菜单Portal归属当前实例，卸载首实例不拆另一菜单与草稿', async () => {
  const first = await fixture('first'), second = await fixture('second');
  try {
    const firstMenu = await first.open();
    assert.equal(resolveOwnedPortalRoot(firstMenu)?.anchor === first.root, true,
      '终端菜单必须登记到所属公开挂载根，供调试器定位');
    assert.equal(firstMenu.getAttribute('data-deviceforge-plugin'), 'deviceforge_terminal');
    assert.equal(firstMenu.getAttribute('data-deviceforge-extension')?.startsWith(
      `${first.root.dataset.deviceforgeExtension}.portal.`), true, '弹层使用所属实例派生的独立扩展标识');
    await key(document.activeElement ?? firstMenu, 'Escape');
    assert.equal(firstMenu.isConnected, false); assert.equal(resolveOwnedPortalRoot(firstMenu), null);
    second.draft.value = '第二实例尚未提交的草稿';
    const secondMenu = await second.open();
    assert.equal(resolveOwnedPortalRoot(secondMenu)?.anchor === second.root, true);
    await first.release();
    assert.equal(first.root.querySelector('button'), null, '卸载应撤销本实例触发器');
    assert.equal(secondMenu.isConnected, true);
    assert.equal(resolveOwnedPortalRoot(secondMenu)?.anchor === second.root, true);
    assert.equal(second.root.querySelector('input') === second.draft, true);
    assert.equal(second.draft.value, '第二实例尚未提交的草稿');
    assert.equal(second.calls.mounted, 1); assert.equal(second.calls.unmounted, 0);
    assert.equal(first.calls.query + first.calls.clear + second.calls.query + second.calls.clear, 0);
    await second.release();
    assert.equal(secondMenu.isConnected, false);
    assert.equal(resolveOwnedPortalRoot(secondMenu), null);
    assert.equal(secondMenu.hasAttribute('data-deviceforge-portal'), false);
    assert.equal(document.querySelector('[role="menu"]'), null);
    assert.equal(second.root.querySelector('button'), null);
  } finally { await first.dispose(); await second.dispose(); }
});
