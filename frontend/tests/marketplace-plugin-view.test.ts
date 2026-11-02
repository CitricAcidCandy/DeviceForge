import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import * as React from 'react';
import { act } from 'react';
import type {
  Dispose, HostResult, JsonValue, WorkspaceInstance, WorkspaceViewContext,
} from '../src/plugin-sdk/index.ts';
import { marketContext } from '../plugins/marketplace/tests/context.ts';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';

function directory(): HostResult<JsonValue> {
  const empty = { known: true, pending: false, entries: [], error: null, logId: null };
  return { logId: 'memory-browser-directory', data: {
    snapshotVersion: 1, packages: empty, installations: empty,
    runtime: [], bundled: [], clients: [], progress: null, cleanup: [], workspaceCleanup: [],
  } };
}
async function fixture(unit: TestContext, waiting = false) {
  const parser = registerCompositionStartupImports();
  assert.deepEqual(parser.diagnostics, []);
  const browser = new JSDOM('<!doctype html><html><body><div id="market"></div></body></html>',
    { url: 'http://127.0.0.1:7031', pretendToBeVisual: true });
  browser.window.HTMLElement.prototype.scrollIntoView = () => {};
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: browser.window, document: browser.window.document, navigator: browser.window.navigator,
    HTMLElement: browser.window.HTMLElement, Element: browser.window.Element, Node: browser.window.Node,
    NodeFilter: browser.window.NodeFilter, HTMLSelectElement: browser.window.HTMLSelectElement,
    DocumentFragment: browser.window.DocumentFragment, HTMLInputElement: browser.window.HTMLInputElement,
    HTMLFormElement: browser.window.HTMLFormElement, HTMLButtonElement: browser.window.HTMLButtonElement,
    CustomEvent: browser.window.CustomEvent, MutationObserver: browser.window.MutationObserver,
    getComputedStyle: browser.window.getComputedStyle.bind(browser.window),
    requestAnimationFrame: browser.window.requestAnimationFrame.bind(browser.window),
    cancelAnimationFrame: browser.window.cancelAnimationFrame.bind(browser.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  let actualNetwork = 0;
  unit.mock.method(globalThis, 'fetch', async () => {
    actualNetwork++; throw new Error('此内存界面单元不允许真实联网');
  });
  const transportSignals: AbortSignal[] = [], managementSignals: AbortSignal[] = [], marketSignals: AbortSignal[] = [];
  const context = marketContext({
    request: async (_input, signal) => {
      transportSignals.push(signal);
      return waiting ? new Promise(() => undefined) : { data: [], logId: 'memory-server-directory' };
    },
    call: async (_input, signal) => {
      managementSignals.push(signal);
      return waiting ? new Promise(() => undefined) : directory();
    },
  });
  const lifetime = new AbortController(), listeners = new Set<(visible: boolean) => void>();
  let snapshot: WorkspaceInstance = {
    instanceId: 'market_unit.main', workspaceId: 'market_unit.workspace', pluginId: 'market_unit',
    provider: { pluginId: 'deviceforge_marketplace', viewId: 'deviceforge_marketplace.main' },
    visible: true, target: null, generation: 1, providerGeneration: 1, state: 'ready', reason: null,
  };
  const instance: WorkspaceViewContext = {
    signal: lifetime.signal, snapshot: () => snapshot,
    subscribeVisibility(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  let release: Dispose | null = null, removeUi: Dispose | null = null, removeMarket: Dispose | null = null;
  async function unmount() {
    const dispose = release; release = null;
    if (dispose) await act(async () => { await dispose(); });
  }
  unit.after(async () => {
    try { await unmount(); await removeMarket?.(); lifetime.abort(); }
    finally {
      await removeUi?.(); parser.dispose(); browser.window.close();
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });
  const { installPublicUi } = await import('../src/app/public-ui.ts');
  removeUi = installPublicUi();
  const { hostUi } = await import('../src/plugin-sdk/index.ts');
  assert.equal(hostUi().React, React);
  const { createMarketplace } = await import('../plugins/marketplace/src/model/index.ts');
  const marketplace = createMarketplace(async (_input, init) => {
    const signal = init?.signal; assert.ok(signal); marketSignals.push(signal);
    return waiting ? new Promise(() => undefined) : Response.json({ entries: [], total: 0, offset: 0, limit: 24 });
  }, { storage: null });
  removeMarket = marketplace.dispose;
  const { mountMarketplace } = await import('../plugins/marketplace/src/view.tsx');
  const root = browser.window.document.getElementById('market'); assert.ok(root);
  await act(async () => { release = await mountMarketplace(root, context, instance, marketplace); });
  return {
    browser, root, context, listeners, transportSignals, managementSignals, marketSignals,
    network: () => actualNetwork, unmount,
    setVisible(visible: boolean) {
      snapshot = { ...snapshot, visible };
      for (const listener of [...listeners]) listener(visible);
    },
  };
}

function button(root: ParentNode, label: string) {
  const found = [...root.querySelectorAll<HTMLButtonElement>('button')]
    .find((entry) => entry.textContent?.trim() === label);
  assert.ok(found, `未找到原市场入口：${label}`);
  return found;
}
function search(root: ParentNode) {
  const input = root.querySelector<HTMLInputElement>('input[aria-label="搜索市场"]');
  assert.ok(input); return input;
}
async function type(input: HTMLInputElement, text: string) {
  const window = input.ownerDocument.defaultView; assert.ok(window);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  assert.ok(setter);
  await act(async () => {
    setter.call(input, text);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

test('真实市场视图共享React并保留原入口，隐藏收起门户后恢复筛选草稿', async (unit) => {
  const f = await fixture(unit);
  assert.match(f.root.textContent ?? '', /资源市场/u);
  for (const label of ['本地导入', '上传发布', '发现资源']) assert.ok(button(f.root, label));
  assert.ok([...f.root.querySelectorAll('button')].some((entry) => entry.textContent?.startsWith('已安装')));
  await type(search(f.root), '保留的市场搜索');
  const nav = f.root.querySelector('[aria-label="市场导航"]'); assert.ok(nav);
  await act(async () => { button(nav, '工具').click(); });
  assert.equal(search(f.root).value, '保留的市场搜索');
  assert.equal(button(nav, '工具').getAttribute('data-current'), 'true');
  await act(async () => { button(f.root, '本地导入').click(); });
  assert.match(f.browser.window.document.querySelector('[role="dialog"]')?.textContent ?? '', /导入|检查/u);
  await act(async () => { f.setVisible(false); });
  assert.equal(f.root.querySelector('[data-product-page="marketplace"]')?.hasAttribute('hidden'), true);
  assert.equal(f.browser.window.document.querySelector('[role="dialog"]'), null);
  assert.equal(search(f.root).value, '保留的市场搜索');
  await act(async () => { f.setVisible(true); });
  assert.equal(search(f.root).value, '保留的市场搜索');
  assert.equal(button(nav, '工具').getAttribute('data-current'), 'true');
  assert.ok(f.browser.window.document.querySelector('[role="dialog"]'));
  await f.unmount();
  assert.equal(f.root.childElementCount, 0);
  assert.equal(f.browser.window.document.querySelector('[role="dialog"]'), null);
  assert.equal(f.context.listenerCount(), 0);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.network(), 0);
});

test('真实市场视图隐藏和释放取消在途观察并收回订阅，不重放写入', async (unit) => {
  const f = await fixture(unit, true);
  // 页面沿用原 200ms 搜索去抖；这里只推进一次真实计时，所有端点均为内存注入。
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 230)); });
  assert.equal(f.marketSignals.length, 1);
  assert.equal(f.managementSignals.length, 1);
  assert.equal(f.transportSignals.length, 2);
  assert.ok(f.context.listenerCount() > 0); assert.equal(f.listeners.size, 1);
  const first = [...f.marketSignals, ...f.managementSignals, ...f.transportSignals];
  await act(async () => { f.setVisible(false); });
  assert.ok(first.every((signal) => signal.aborted));
  assert.equal(f.marketSignals.length, 1);
  await act(async () => { f.setVisible(true); });
  assert.equal(f.managementSignals.length, 2);
  await f.unmount();
  assert.ok([...f.marketSignals, ...f.managementSignals, ...f.transportSignals].every((signal) => signal.aborted));
  assert.equal(f.context.listenerCount(), 0); assert.equal(f.listeners.size, 0);
  assert.equal(f.root.childElementCount, 0);
  assert.equal(f.network(), 0);
});
