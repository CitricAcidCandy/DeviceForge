import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { act } from 'react';
import { flushSync } from 'react-dom';
import { JSDOM } from 'jsdom';
import type { Dispose, HostResult, JsonValue, WorkspaceInstance, WorkspaceViewContext } from '../src/plugin-sdk/index.ts';
import type { MarketplaceEntry } from '../plugins/marketplace/src/model/index.ts';
import { marketContext } from '../plugins/marketplace/tests/context.ts';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';

function entry(id: string, name: string): MarketplaceEntry {
  return {
    metadata_version: 1, id, kind: 'plugin', name, version: '1.0.0', summary: '内存焦点单元条目',
    description: '只验证原卡片和详情，不安装、下载或写入。', keywords: [], categories: ['function'],
    applies_to: ['deviceforge'], supports_mcp: 'none', supports_agent: false, restart_policy: 'none',
    platforms: [], architectures: [], resource_id: 'a'.repeat(64), details: { plugin_kind: 'browser' },
    source: 'https://market.invalid', sourceName: '内存市场',
  };
}
function directory(): HostResult<JsonValue> {
  const empty = { known: true, pending: false, entries: [], error: null, logId: null };
  return { data: { snapshotVersion: 1, packages: empty, installations: empty,
    runtime: [], bundled: [], clients: [], progress: null, cleanup: [], workspaceCleanup: [] }, logId: 'memory-directory' };
}
async function fixture(unit: TestContext) {
  const imports = registerCompositionStartupImports(); assert.deepEqual(imports.diagnostics, []);
  const browser = new JSDOM('<!doctype html><html><body><main></main><button id="outside">其他实例入口</button></body></html>', {
    url: 'http://127.0.0.1:7031/#/marketplace', pretendToBeVisual: true,
  });
  const w = browser.window, document = w.document;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: w, document, navigator: w.navigator, HTMLElement: w.HTMLElement, Element: w.Element,
    Node: w.Node, NodeFilter: w.NodeFilter, DocumentFragment: w.DocumentFragment,
    HTMLInputElement: w.HTMLInputElement, HTMLButtonElement: w.HTMLButtonElement,
    HTMLFormElement: w.HTMLFormElement, HTMLSelectElement: w.HTMLSelectElement,
    Event: w.Event, KeyboardEvent: w.KeyboardEvent, FocusEvent: w.FocusEvent,
    MutationObserver: w.MutationObserver, CustomEvent: w.CustomEvent,
    getComputedStyle: w.getComputedStyle.bind(w),
    requestAnimationFrame: w.requestAnimationFrame.bind(w), cancelAnimationFrame: w.cancelAnimationFrame.bind(w),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  w.HTMLElement.prototype.scrollIntoView = () => {};
  let network = 0, writes = 0, catalogReads = 0, directoryReads = 0;
  unit.mock.method(globalThis, 'fetch', async () => { network++; throw new Error('详情焦点单元禁止真实网络'); });
  const context = marketContext({
    request: async (input) => {
      if (input.method && input.method !== 'GET') { writes++; throw new Error('禁止管理写入'); }
      directoryReads++; return { data: [], logId: 'memory-server-directory' };
    },
    call: async (input) => {
      if (!input || typeof input !== 'object' || Array.isArray(input) ||
          (input.action !== 'snapshot' && input.action !== 'refresh')) {
        writes++; throw new Error('禁止插件管理操作');
      }
      directoryReads++; return directory();
    },
  });
  const { installPublicUi } = await import('../src/app/public-ui.ts');
  const removeUi = installPublicUi();
  const { createMarketplace } = await import('../plugins/marketplace/src/model/index.ts');
  const entries = [entry('focus_alpha', '甲插件'), entry('focus_beta', '乙插件')];
  const marketplace = createMarketplace(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (init?.method && init.method !== 'GET' || !url.pathname.endsWith('/catalog')) {
      writes++; throw new Error('禁止下载、安装或发布');
    }
    catalogReads++;
    const values = url.searchParams.get('q') === '没有匹配条目' ? [] : entries;
    return Response.json({ entries: values, total: values.length, offset: 0, limit: 24 });
  }, { storage: null });
  const lifetime = new AbortController(), listeners = new Set<(visible: boolean) => void>();
  let current: WorkspaceInstance = {
    instanceId: 'market-focus.main', workspaceId: 'market-focus.workspace', pluginId: 'market-focus',
    provider: { pluginId: 'deviceforge_marketplace', viewId: 'deviceforge_marketplace.main' },
    target: null, visible: true, generation: 1, providerGeneration: 1, state: 'ready', reason: null,
  };
  const instance: WorkspaceViewContext = {
    signal: lifetime.signal, snapshot: () => current,
    subscribeVisibility(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const root = document.querySelector('main'), outside = document.getElementById('outside');
  assert.ok(root && outside instanceof w.HTMLButtonElement);
  const { mountMarketplace } = await import('../plugins/marketplace/src/view.tsx');
  let release: Dispose | null = null;
  await act(async () => { release = await mountMarketplace(root, context, instance, marketplace); });
  async function unmount(afterDetach?: () => void) {
    const dispose = release; release = null;
    if (dispose) await act(async () => {
      await dispose(); afterDetach?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
  }
  unit.after(async () => {
    try {
      await unmount(); await marketplace.dispose(); lifetime.abort();
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      await removeUi(); imports.dispose(); browser.window.close();
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });
  async function settleCatalog() { await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 230)); }); }
  await settleCatalog();
  return {
    root, document, browser, outside, unmount, settleCatalog, writes: () => writes, network: () => network,
    reads: () => [catalogReads, directoryReads], listeners,
    async visible(visible: boolean, afterCommit?: () => void) {
      await act(async () => {
        flushSync(() => { current = { ...current, visible }; for (const listener of [...listeners]) listener(visible); });
        afterCommit?.();
      });
    },
  };
}

function named(root: ParentNode, name: string) {
  const found = [...root.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => (button.getAttribute('aria-label') ?? button.textContent?.trim()) === name);
  assert.ok(found, `缺少原市场入口：${name}`); return found;
}
function search(root: ParentNode) {
  const result = root.querySelector<HTMLInputElement>('[aria-label="搜索市场"]'); assert.ok(result); return result;
}
function dialog(document: Document) {
  const result = document.querySelector<HTMLElement>('[role="dialog"]'); assert.ok(result); return result;
}
async function click(button: HTMLButtonElement) { await act(async () => { button.focus(); button.click(); }); }
async function type(input: HTMLInputElement, value: string) {
  const w = input.ownerDocument.defaultView; assert.ok(w);
  const setter = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value')?.set; assert.ok(setter);
  await act(async () => { setter.call(input, value); input.dispatchEvent(new w.Event('input', { bubbles: true })); });
}

test('市场详情返焦：真实卡片标题与安装入口分别关闭后返回原按钮，保搜索与零业务写入', async (unit) => {
  const f = await fixture(unit);
  const input = search(f.root);
  await type(input, '保留的市场草稿'); await f.settleCatalog();
  const title = named(f.root, '查看 甲插件 详情');
  const secondTitle = named(f.root, '查看 乙插件 详情');
  const card = secondTitle.closest('article'); assert.ok(card);
  const install = named(card, '安装'); assert.equal(install.disabled, false);
  const counts = f.reads();
  await click(title);
  const firstDetail = dialog(f.document); assert.match(firstDetail.textContent ?? '', /甲插件/u);
  await act(async () => { firstDetail.dispatchEvent(new f.browser.window.KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true,
  })); });
  assert.equal(firstDetail.isConnected, false);
  assert.equal(f.document.activeElement === title, true, 'Escape必须返回实际点击的卡片标题');
  await click(install);
  const secondDetail = dialog(f.document); assert.match(secondDetail.textContent ?? '', /乙插件/u);
  await click(named(secondDetail, '关闭'));
  assert.equal(secondDetail.isConnected, false);
  assert.equal(f.document.activeElement === install, true, '关闭按钮必须返回此次安装入口，而非另一张卡片标题');
  assert.equal(search(f.root) === input, true);
  assert.equal(input.value, '保留的市场草稿');
  assert.equal(named(f.root, '查看 甲插件 详情') === title, true);
  assert.equal(named(f.root, '查看 乙插件 详情') === secondTitle, true);
  assert.deepEqual(f.reads(), counts, '详情打开/取消不重新读取市场或安装目录');
  assert.equal(f.document.querySelector('[role="dialog"]'), null);
  assert.equal(f.writes(), 0); assert.equal(f.network(), 0);
});

test('市场详情返焦：隐藏及卸载不夺外部焦点，详情按原约定恢复且失效入口不聚焦别卡片', async (unit) => {
  const f = await fixture(unit);
  const title = named(f.root, '查看 甲插件 详情');
  await click(title);
  const initial = dialog(f.document);
  await f.visible(false, () => { f.outside.focus(); });
  assert.equal(initial.isConnected, false);
  assert.equal(f.document.activeElement === f.outside, true);
  await f.visible(true); await f.settleCatalog();
  const restored = dialog(f.document);
  assert.match(restored.textContent ?? '', /甲插件/u, '详情保留原恢复约定，不把切页当用户关闭');
  const restoredTrigger = named(f.root, '查看 甲插件 详情');
  await act(async () => { restored.dispatchEvent(new f.browser.window.KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true,
  })); });
  assert.equal(restored.isConnected, false);
  assert.equal(f.document.activeElement === restoredTrigger, true, '恢复重建卡片后仍回同条目当前入口');
  await click(restoredTrigger);
  const removedEntryDetail = dialog(f.document);
  const input = search(f.root);
  // 使用真实筛选使原入口被移除，不手工伪造缺失DOM，也不按条目ID偷换返焦目标。
  await type(input, '没有匹配条目'); await f.settleCatalog();
  assert.equal(title.isConnected, false);
  assert.equal(f.root.querySelector('article'), null);
  await click(named(removedEntryDetail, '关闭'));
  assert.equal(removedEntryDetail.isConnected, false);
  assert.equal(f.document.activeElement?.closest('article') ?? null, null, '失效入口不应改聚焦其他卡片');
  await type(input, '恢复目录'); await f.settleCatalog();
  await click(named(f.root, '查看 乙插件 详情'));
  const beforeUnmount = dialog(f.document);
  await f.unmount(() => { f.outside.focus(); });
  assert.equal(beforeUnmount.isConnected, false);
  assert.equal(f.document.activeElement === f.outside, true, '卸载详情不得夺走已转移的外部焦点');
  assert.equal(f.root.childElementCount, 0);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.writes(), 0); assert.equal(f.network(), 0);
});
