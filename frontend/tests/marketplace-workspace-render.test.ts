import assert from 'node:assert/strict';
import test from 'node:test';
import { inspect } from 'node:util';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { compile } from 'tailwindcss';
import type { Dispose } from '../src/plugin-sdk/index.ts';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';
import { success } from './fixtures.ts';

function button(target: ParentNode, label: string): HTMLButtonElement {
  const found = [...target.querySelectorAll<HTMLButtonElement>('button')]
    .find((entry) => entry.textContent?.trim() === label);
  assert.ok(found, `真实市场按钮没有留在DOM：${label}`);
  return found;
}

async function settle(milliseconds = 0) {
  await act(async () => {
    if (milliseconds) await new Promise<void>((accept) => setTimeout(accept, milliseconds));
    for (let index = 0; index < 3; index++) {
      await Promise.resolve();
      await new Promise<void>((accept) => setImmediate(accept));
    }
  });
}

test('真实市场工作区经纯平台管理契约挂载后标题按钮跨查询微任务持续留在DOM',
  { timeout: 20_000 }, async (unit) => {
    const parser = registerCompositionStartupImports();
    assert.deepEqual(parser.diagnostics, []);
    const browser = new JSDOM('<!doctype html><html><head></head><body><main id="market"></main></body></html>',
      { url: 'http://127.0.0.1:7031', pretendToBeVisual: true });
    const document = browser.window.document, target = document.getElementById('market');
    assert.ok(target);
    const saved = new Map<string, PropertyDescriptor | undefined>();
    for (const [name, value] of Object.entries({
      window: browser.window, self: browser.window, document, navigator: browser.window.navigator,
      HTMLElement: browser.window.HTMLElement, HTMLInputElement: browser.window.HTMLInputElement,
      HTMLButtonElement: browser.window.HTMLButtonElement, HTMLFormElement: browser.window.HTMLFormElement,
      HTMLSelectElement: browser.window.HTMLSelectElement, Element: browser.window.Element, Node: browser.window.Node,
      NodeFilter: browser.window.NodeFilter, DocumentFragment: browser.window.DocumentFragment,
      CustomEvent: browser.window.CustomEvent, Event: browser.window.Event,
      MutationObserver: browser.window.MutationObserver,
      getComputedStyle: browser.window.getComputedStyle.bind(browser.window),
      requestAnimationFrame: browser.window.requestAnimationFrame.bind(browser.window),
      cancelAnimationFrame: browser.window.cancelAnimationFrame.bind(browser.window),
      IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    const errors: unknown[] = [], hostRequests: string[] = [], marketRequests: string[] = [];
    const signals: AbortSignal[] = [], violations: string[] = [];
    const onWindowError = (event: ErrorEvent) => { errors.push(event.error ?? event.message); event.preventDefault(); };
    const onUnhandled = (error: unknown) => { errors.push(error); };
    browser.window.addEventListener('error', onWindowError);
    process.on('unhandledRejection', onUnhandled);
    unit.mock.method(console, 'error', (...values: unknown[]) => { errors.push(values); });
    const forbidden = (description: string): never => { violations.push(description); throw new Error(description); };
    const entry = {
      metadata_version: 1, id: 'render_fixture', kind: 'plugin', name: '只读目录测试插件', version: '0.1.0',
      summary: '只用于验证真实市场组件持续挂载', description: '无安装或任务副作用', keywords: ['render'],
      categories: ['function'], applies_to: ['deviceforge'], supports_mcp: 'none', supports_agent: false,
      restart_policy: 'none', platforms: ['win32'], architectures: ['x64'],
      details: { plugin_kind: 'browser' },
    };
    const hostPaths = new Set(['/api/v2/plugin-packages/server', '/api/v2/plugin-packages/browser',
      '/api/v2/plugins', '/api/v2/plugin-installations']);
    const hostTransport: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== 'http://127.0.0.1:7031' || (init?.method ?? 'GET') !== 'GET' ||
          !hostPaths.has(url.pathname) || url.search) return forbidden(`不允许的宿主请求：${init?.method} ${url.pathname}`);
      hostRequests.push(url.pathname);
      assert.ok(init?.signal);
      signals.push(init.signal);
      return success([], 'market-render-host-read');
    };
    unit.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== 'http://127.0.0.1:7040' || url.pathname !== '/api/v1/catalog' ||
          (init?.method ?? 'GET') !== 'GET') return forbidden(`不允许的市场请求：${init?.method} ${url.pathname}`);
      marketRequests.push(url.pathname + url.search);
      assert.ok(init?.signal);
      signals.push(init.signal);
      return Response.json({ entries: [entry], total: 1, offset: 0, limit: 24 });
    });
    const frames: { page: boolean; title: string | null; buttons: number }[] = [];
    const observer = new browser.window.MutationObserver(() => {
      frames.push({ page: target.querySelector('[data-product-page="marketplace"]') !== null,
        title: target.querySelector('h1')?.textContent ?? null, buttons: target.querySelectorAll('button').length });
    });
    const lifetime = new AbortController();
    let release: Dispose | undefined, removeUi: Dispose | undefined, closeRuntime: Dispose | undefined;
    const assertRendered = () => {
      const page = target.querySelector('[data-product-page="marketplace"]');
      assert.ok(page, `真实市场根已经消失；捕获错误：${inspect(errors)}`);
      assert.equal(page.hasAttribute('hidden'), false);
      for (const name of ['@container/marketplace', 'min-w-0', 'overflow-y-auto'])
        assert.ok(page.classList.contains(name), `市场根缺少容器适配规则：${name}`);
      const navigation = page.querySelector('[aria-label="市场导航"]'); assert.ok(navigation);
      assert.ok(navigation.classList.contains('@min-[720px]/marketplace:flex'));
      assert.equal(navigation.classList.contains('md:flex'), false);
      const grid = page.querySelector('[data-marketplace-grid]'); assert.ok(grid);
      assert.ok(grid.classList.contains('[grid-template-columns:repeat(auto-fill,minmax(min(100%,18.75rem),1fr))]'));
      assert.equal(page.querySelector('h1')?.textContent, '资源市场');
      assert.equal(page.querySelectorAll('input[aria-label="搜索市场"]').length, 1,
        '真实市场搜索框应按唯一可访问名称定位');
      for (const label of ['刷新', '本地导入', '上传发布', '发现资源']) button(page, label);
      return page;
    };
    try {
      const { createPlatformRuntime } = await import('../src/app/platform-runtime.ts');
      const { registerBrowserManagementServices } = await import('../src/app/composition/browser-management.ts');
      const { installPublicUi } = await import('../src/app/public-ui.ts');
      const { createMarketplacePlugin } = await import('../plugins/marketplace/src/index.ts');
      removeUi = installPublicUi();
      const runtime = createPlatformRuntime({
        baseUrl: 'http://127.0.0.1:7031', panelTarget: () => null,
        workspaceStorage: null, transport: hostTransport,
      });
      closeRuntime = runtime.dispose;
      registerBrowserManagementServices({ host: runtime.host, extensions: runtime.webPlugins.extensions }, { runtime });
      const id = 'deviceforge_marketplace';
      runtime.bundledPlugins.register({ id, trusted: true, plugin: createMarketplacePlugin({ id, version: '0.1.0' }) });
      await act(async () => { await runtime.webPlugins.load(id); });
      const ui = runtime.host.ui, mount = ui?.mount;
      assert.ok(ui && mount);
      assert.ok(ui.catalog().pages.some((page) => page.pluginId === id && page.route === '/marketplace'));
      const instance = ui.snapshot().instances.find((current) => current.provider?.pluginId === id);
      assert.ok(instance && instance.state === 'ready' && instance.visible);
      assert.equal(hostRequests.length, 0, '激活登记本身不请求目录');
      assert.equal(marketRequests.length, 0);
      await act(async () => { release = await mount(instance.instanceId, target, lifetime.signal); });
      const page = assertRendered();
      const compiler = await compile('@theme { --spacing: 0.25rem; } @tailwind utilities;');
      const css = compiler.build(['@min-[720px]/marketplace:flex', '[grid-template-columns:repeat(auto-fill,minmax(min(100%,18.75rem),1fr))]']);
      assert.match(css, /@container marketplace \(width >= 720px\)/);
      assert.match(css, /minmax\(min\(100%,\s*18\.75rem\),\s*1fr\)/);
      // 挂载器异步加载组件前的占位不属于已提交页面消失。
      observer.observe(target, { childList: true, subtree: true });
      await settle(240);
      assert.equal(assertRendered(), page, '查询回执不能替换或清空已提交的真实市场根');
      assert.match(page.textContent ?? '', /只读目录测试插件/u);
      assert.ok(marketRequests.length > 0, '必须真正经过200ms去抖和市场响应状态更新');
      for (const path of hostPaths) assert.ok(hostRequests.includes(path), `未经过真实管理观察端点：${path}`);
      await settle();
      assert.equal(assertRendered(), page);
      await act(async () => { button(page, '刷新').click(); });
      await settle(240);
      assert.equal(assertRendered(), page);
      await act(async () => { ui.setVisible(instance.instanceId, false); });
      assert.equal(page.hasAttribute('hidden'), true);
      await act(async () => { ui.setVisible(instance.instanceId, true); });
      await settle(240);
      assert.equal(assertRendered(), page);
      assert.deepEqual(violations, []);
      assert.deepEqual(errors, [], `捕获真实React/微任务错误：${inspect(errors)}`);
      assert.ok(frames.length > 0 && frames.every((frame) => frame.page && frame.title === '资源市场' && frame.buttons > 0),
        `提交后的DOM观测出现空白：${inspect(frames)}`);
      observer.disconnect();
      await act(async () => { await release?.(); });
      release = undefined;
      lifetime.abort();
      await act(async () => { await runtime.webPlugins.unload(id); await runtime.dispose(); });
      closeRuntime = undefined;
      assert.equal(target.childElementCount, 0);
      assert.equal(document.querySelector('[role="dialog"]'), null);
      assert.ok(signals.every((signal) => signal.aborted), '释放应撤销本测试所有观察请求信号');
      assert.deepEqual(errors, []);
      unit.diagnostic(`真实根跨查询/刷新/可见性仍保留；宿主只读请求${hostRequests.length}次，市场只读查询${marketRequests.length}次，未调用网络栈`);
    } finally {
      observer.disconnect();
      try {
        await act(async () => { await release?.(); lifetime.abort(); await closeRuntime?.(); });
        await removeUi?.();
      } finally {
        process.removeListener('unhandledRejection', onUnhandled);
        browser.window.removeEventListener('error', onWindowError);
        browser.window.close();
        parser.dispose();
        for (const [name, descriptor] of saved) {
          if (descriptor) Object.defineProperty(globalThis, name, descriptor);
          else Reflect.deleteProperty(globalThis, name);
        }
      }
    }
  });
