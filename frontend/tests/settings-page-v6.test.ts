import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import type { ComponentType } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import type { ProductServices } from '../src/app/product/services.ts';
import { createSettingsV6Fixture } from '../scripts/settings-v6-fixture.ts';

function pageModule(value: unknown): value is { SettingsPage: ComponentType<{ services: ProductServices }> } {
  return typeof value === 'object' && value !== null && 'SettingsPage' in value && typeof value.SettingsPage === 'function';
}

test('设置纵向分类保留草稿、隔离连接与市场操作，并回收插件追加', { timeout: 90_000 }, async () => {
  const browser = new JSDOM('<!doctype html><html><body><div id="settings-test"></div></body></html>', {
    url: 'http://localhost:7031/#settings', pretendToBeVisual: true,
  });
  const w = browser.window;
  const copied: string[] = [];
  Object.defineProperty(w.navigator, 'clipboard', { configurable: true, value: {
    async writeText(value: string) { copied.push(value); },
  } });
  Object.defineProperty(w, 'matchMedia', { configurable: true, value: (media: string): MediaQueryList => ({
    matches: false, media, onchange: null, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
  }) });
  const globals: Readonly<Record<string, unknown>> = {
    window: w, document: w.document, navigator: w.navigator, Element: w.Element, HTMLElement: w.HTMLElement,
    HTMLButtonElement: w.HTMLButtonElement, HTMLInputElement: w.HTMLInputElement, HTMLTextAreaElement: w.HTMLTextAreaElement,
    HTMLSelectElement: w.HTMLSelectElement, HTMLFormElement: w.HTMLFormElement, DocumentFragment: w.DocumentFragment,
    Node: w.Node, NodeFilter: w.NodeFilter, MutationObserver: w.MutationObserver, Event: w.Event,
    MouseEvent: w.MouseEvent, PointerEvent: w.MouseEvent, KeyboardEvent: w.KeyboardEvent, FocusEvent: w.FocusEvent,
    CustomEvent: w.CustomEvent, getComputedStyle: w.getComputedStyle.bind(w),
    requestAnimationFrame: w.requestAnimationFrame.bind(w), cancelAnimationFrame: w.cancelAnimationFrame.bind(w),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const target = w.document.getElementById('settings-test');
  assert.ok(target);
  const fixture = await createSettingsV6Fixture(target);
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(target);
  const button = (name: string) => {
    const node = [...target.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === name);
    assert.ok(node, `缺少按钮：${name}`);
    return node;
  };
  const field = (selector: string) => {
    const node = target.querySelector(selector);
    assert.ok(node instanceof w.HTMLInputElement || node instanceof w.HTMLTextAreaElement, `缺少字段：${selector}`);
    return node;
  };
  const fill = async (selector: string, value: string) => {
    const node = field(selector);
    const prototype = node instanceof w.HTMLTextAreaElement ? w.HTMLTextAreaElement.prototype : w.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    assert.ok(setter);
    await act(async () => {
      setter.call(node, value);
      node.dispatchEvent(new w.Event('input', { bubbles: true }));
      node.dispatchEvent(new w.Event('change', { bubbles: true }));
    });
  };
  const click = async (name: string) => { await act(async () => button(name).click()); };
  const wait = async (condition: () => boolean, name: string) => {
    for (let tick = 0; tick < 100 && !condition(); tick++) await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 10)); });
    assert.ok(condition(), name);
  };
  const choose = async (name: string) => {
    const nav = target.querySelector('nav[aria-label="设置分类"]');
    assert.ok(nav);
    const entry = [...nav.querySelectorAll('button')].find((node) => node.textContent?.trim() === name);
    assert.ok(entry);
    await act(async () => entry.click());
    assert.equal(entry.getAttribute('aria-current'), 'page');
    assert.equal(nav.querySelectorAll('[aria-current="page"]').length, 1);
  };
  try {
    const loaded: unknown = await server.ssrLoadModule('/src/pages/settings/index.tsx');
    assert.ok(pageModule(loaded));
    await act(async () => {
      root.render(createElement(loaded.SettingsPage, { services: fixture.services }));
      await fixture.services.runtime.operations.refresh(new AbortController().signal);
    });
    const nav = target.querySelector('nav[aria-label="设置分类"]');
    assert.ok(nav);
    assert.deepEqual([...nav.querySelectorAll('button')].map((entry) => entry.textContent?.trim()), ['服务连接', '外观与主题', '工具配置', '插件扩展']);
    assert.equal(nav.querySelector('[aria-current="page"]')?.textContent?.trim(), '服务连接');
    const serverField = field('#settings-server-url');
    await fill('#settings-server-url', 'http://192.168.50.20:7031');
    await fill('#settings-server-token', 'test-session-token');
    assert.equal(field('#settings-server-token').getAttribute('type'), 'password');
    await act(async () => {
      const toggle = target.querySelector('button[aria-label="显示服务令牌"]');
      assert.ok(toggle instanceof w.HTMLButtonElement);
      toggle.click();
    });
    assert.equal(field('#settings-server-token').getAttribute('type'), 'text');
    await choose('工具配置');
    const toolDraft = field('#settings-content');
    await fill('#settings-content', '{"草稿":"分类切换保持"}');
    await choose('外观与主题');
    assert.ok(target.querySelector('#settings-theme'));
    await choose('服务连接');
    assert.equal(field('#settings-server-url'), serverField);
    assert.equal(field('#settings-server-url').value, 'http://192.168.50.20:7031');
    assert.equal(field('#settings-server-token').value, 'test-session-token');
    await choose('工具配置');
    assert.equal(field('#settings-content'), toolDraft);
    assert.equal(toolDraft.value, '{"草稿":"分类切换保持"}');
    await choose('服务连接');
    assert.doesNotMatch(w.localStorage.length ? JSON.stringify(Object.entries(w.localStorage)) : '', /test-session-token/);
    assert.doesNotMatch(JSON.stringify(Object.entries(w.sessionStorage)), /test-session-token/);
    assert.doesNotMatch(w.location.href, /test-session-token/);

    await fill('#settings-server-url', 'ftp://127.0.0.1:7031');
    await click('测试并应用');
    assert.equal(fixture.reconnects.length, 0, '非法协议不应触发连接');
    assert.match(target.textContent ?? '', /http:\/\/|https:\/\//);
    await fill('#settings-server-url', 'http://127.0.0.1:7031');
    fixture.mode('waiting');
    await click('测试并应用');
    await wait(() => fixture.reconnects.length === 1, '连接未开始');
    await fill('#settings-marketplace-url', 'http://192.168.50.20:7040');
    await click('保存并刷新');
    await wait(() => fixture.services.marketplace.currentUrl() === 'http://192.168.50.20:7040', '市场覆盖未保存');
    assert.equal(fixture.reconnects[0]?.signal.aborted, false, '市场保存不能取消连接等待');
    assert.equal(fixture.writes.length, 0, '市场覆盖不能写入服务器配置');
    await choose('工具配置');
    await click('读取配置');
    await wait(() => (target.textContent ?? '').includes('当前修订：1'), '工具配置读取未完成');
    assert.equal(fixture.reconnects[0]?.signal.aborted, false, '切换分类并读取工具配置不能取消连接等待');
    await choose('服务连接');
    await act(async () => fixture.complete());
    await wait(() => [...target.querySelectorAll('button')].some((entry) => entry.textContent?.trim() === '测试并应用' && !entry.disabled), '连接结束后按钮未恢复');
    await click('恢复默认');
    assert.equal(fixture.services.marketplace.currentUrl(), fixture.services.marketplace.defaultUrl);
    assert.equal(w.localStorage.getItem('deviceforge.marketplace.url'), null);

    fixture.mode('network');
    await click('测试并应用');
    await wait(() => (target.textContent ?? '').includes('未取得日志 ID'), '服务无响应未解释日志缺失');
    assert.match(target.textContent ?? '', /无法连接服务/);
    assert.doesNotMatch(target.textContent ?? '', /log_demo|settings-v6-real-response-log/);
    fixture.mode('logged');
    await click('重新测试');
    await wait(() => (target.textContent ?? '').includes('settings-v6-real-response-log'), '真实响应日志未保留');
    await click('复制日志 ID');
    assert.deepEqual(copied, ['settings-v6-real-response-log'], '复制入口必须使用本次真实响应日志 ID');

    await act(async () => fixture.loadPlugin());
    await choose('插件扩展');
    await wait(() => target.querySelector('[aria-label="插件草稿"]') !== null, '插件追加未在分类内挂载');
    const pluginField = field('[aria-label="插件草稿"]');
    await fill('[aria-label="插件草稿"]', '插件草稿保持');
    const mounts = fixture.mounted.count;
    await choose('服务连接');
    await choose('插件扩展');
    assert.equal(target.querySelector('[aria-label="插件草稿"]'), pluginField);
    assert.equal(pluginField.value, '插件草稿保持');
    assert.equal(fixture.mounted.count, mounts, '切换分类不应重复挂载插件');
    await act(async () => fixture.unloadPlugin());
    await wait(() => target.querySelector('[aria-label="插件草稿"]') === null, '卸载后插件内容未撤销');
    assert.equal(fixture.mounted.released, mounts);
  } finally {
    try {
      await act(async () => root.unmount());
      await fixture.dispose();
    } finally {
      await server.close();
      browser.window.close();
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  }
});
