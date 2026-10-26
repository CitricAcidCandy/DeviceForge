import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { createFrontendRuntime } from '../src/app/index.ts';
import { createNamedSlotAdapter } from '../src/plugins/index.ts';
import type { ProductServices } from '../src/app/product/services.ts';
import type { WebPlugin } from '../src/plugin-sdk/index.ts';
import { job, success } from './fixtures.ts';

interface SurfaceModule {
  readonly ExtensionSurface: ComponentType<{
    services: ProductServices;
    slot: string;
    fallback: ReactNode;
    fill?: boolean;
  }>;
  readonly RouteSurface: ComponentType<{
    services: ProductServices;
    route: string;
    children: ReactNode;
  }>;
}

function installBrowser() {
  const browser = new JSDOM('<!doctype html><html><body><div id="test-app"></div></body></html>', {
    url: 'http://localhost:7031',
    pretendToBeVisual: true,
  });
  const windowRef = browser.window;
  Object.defineProperty(windowRef, 'matchMedia', {
    configurable: true,
    value: (media: string): MediaQueryList => ({
      matches: false,
      media,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return true;
      },
    }),
  });
  const globals: Readonly<Record<string, unknown>> = {
    window: windowRef,
    document: windowRef.document,
    navigator: windowRef.navigator,
    Element: windowRef.Element,
    DocumentFragment: windowRef.DocumentFragment,
    HTMLElement: windowRef.HTMLElement,
    HTMLFormElement: windowRef.HTMLFormElement,
    HTMLInputElement: windowRef.HTMLInputElement,
    HTMLSelectElement: windowRef.HTMLSelectElement,
    HTMLTextAreaElement: windowRef.HTMLTextAreaElement,
    HTMLButtonElement: windowRef.HTMLButtonElement,
    HTMLAnchorElement: windowRef.HTMLAnchorElement,
    Node: windowRef.Node,
    NodeFilter: windowRef.NodeFilter,
    MutationObserver: windowRef.MutationObserver,
    Event: windowRef.Event,
    FocusEvent: windowRef.FocusEvent,
    KeyboardEvent: windowRef.KeyboardEvent,
    MouseEvent: windowRef.MouseEvent,
    PointerEvent: windowRef.MouseEvent,
    CustomEvent: windowRef.CustomEvent,
    getComputedStyle: windowRef.getComputedStyle.bind(windowRef),
    requestAnimationFrame: windowRef.requestAnimationFrame.bind(windowRef),
    cancelAnimationFrame: windowRef.cancelAnimationFrame.bind(windowRef),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const descriptors = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  return {
    windowRef,
    restore() {
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      browser.window.close();
    },
  };
}

function surfaceModule(value: unknown): value is SurfaceModule {
  return (
    value !== null &&
    typeof value === 'object' &&
    'ExtensionSurface' in value &&
    'RouteSurface' in value &&
    typeof value.ExtensionSurface === 'function' &&
    typeof value.RouteSurface === 'function'
  );
}

const stubPlugin = (log: string[]): WebPlugin => ({
  id: 'stub',
  version: '1.0',
  apiVersion: 2,
  panels: [],
  contributions: {
    components: [
      {
        id: 'stub.pane',
        title: '桩视图',
        slot: 'route.performance',
        mode: 'replace',
        mount: async (target) => {
          log.push('mount');
          const node = target.ownerDocument.createElement('p');
          node.dataset.stubPlugin = '';
          node.textContent = '插件接管';
          target.append(node);
          return () => {
            log.push('release');
            node.remove();
          };
        },
      },
    ],
  },
});

// 90s 只覆盖 JSDOM + Vite 模块装载的启动开销（本机单次约 20-30s），不是行为断言放宽。
test('路由槽位：插件接管整页、恢复默认回落后再启用、卸载插件自动复原', { timeout: 90_000 }, async () => {
  const browser = installBrowser();
  const { document } = browser.windowRef;
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  const adapter = await createNamedSlotAdapter([]);
  const runtime = createFrontendRuntime({
    baseUrl: 'http://localhost:7031',
    panelTarget: () => null,
    transport: async () => success(job()),
    slotAdapter: adapter,
  });
  const services = { runtime } as unknown as ProductServices;
  const target = document.getElementById('test-app');
  assert.ok(target);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(target);
  const log: string[] = [];
  // 一次 act 只保证已排队的微任务落地；挂载链路要走 define → mount 两跳，用少量轮次推进。
  const flush = async (steps = 3) => {
    for (let index = 0; index < steps; index += 1)
      await act(async () => {
        await Promise.resolve();
      });
  };
  const button = (label: string) =>
    Array.from(target.querySelectorAll('button')).find(
      (entry) => entry.textContent?.trim() === label,
    );
  // 断言一律收敛成布尔：JSDOM 节点与 null 直接比较，失败时断言库会深度 inspect
  // ownerDocument → defaultView → document 的环，几秒内就把堆吃光。
  const text = (selector: string) => target.querySelector(selector)?.textContent ?? null;
  const missing = (selector: string) => target.querySelector(selector) === null;
  try {
    const loaded: unknown = await server.ssrLoadModule('/src/app/product/slots.tsx');
    assert.ok(surfaceModule(loaded), '槽位模块应导出挂载器组件');
    await act(async () => {
      root.render(
        createElement(loaded.ExtensionSurface, {
          services,
          slot: 'route.performance',
          fill: true,
          fallback: createElement('div', { 'data-host-page': '' }, '宿主页面'),
        }),
      );
    });
    await flush();
    assert.equal(text('[data-host-page]'), '宿主页面');
    assert.equal(
      target.querySelector('[data-deviceforge-surface="route.performance"]')?.className,
      'contents',
      '没有插件接管时槽位不参与布局',
    );

    runtime.webPlugins.register({ id: 'stub', trusted: true, plugin: stubPlugin(log) });
    await act(async () => {
      await runtime.webPlugins.load('stub');
    });
    await flush();
    assert.equal(text('[data-stub-plugin]'), '插件接管');
    assert.ok(missing('[data-host-page]'), '接管期间不渲染宿主页面');
    assert.match(
      target.querySelector('[data-deviceforge-surface="route.performance"]')?.className ?? '',
      /\bflex\b/,
      '接管期间槽位撑开整页',
    );
    assert.deepEqual(log, ['mount']);

    const restore = button('恢复默认');
    assert.ok(restore, '接管态必须提供恢复默认');
    await act(async () => {
      restore.click();
    });
    await flush();
    assert.equal(text('[data-host-page]'), '宿主页面');
    assert.ok(missing('[data-stub-plugin]'));
    assert.deepEqual(log, ['mount', 'release']);

    const enable = button('启用插件视图');
    assert.ok(enable, '关闭后必须能重新启用');
    await act(async () => {
      enable.click();
    });
    await flush();
    assert.equal(text('[data-stub-plugin]'), '插件接管');
    assert.ok(missing('[data-host-page]'));

    await act(async () => {
      await runtime.webPlugins.unload('stub');
    });
    await flush();
    assert.equal(text('[data-host-page]'), '宿主页面');
    assert.ok(missing('[data-stub-plugin]'));
    assert.equal(
      target.querySelector('[data-deviceforge-surface="route.performance"]')?.className,
      'contents',
      '卸载插件后槽位自动退出布局',
    );
  } finally {
    await act(async () => {
      root.unmount();
    });
    await runtime.dispose();
    await adapter.dispose();
    await server.close();
    browser.restore();
  }
});

const modulePlugin = (log: string[]): WebPlugin => ({
  id: 'demo',
  version: '1.0',
  apiVersion: 2,
  panels: [],
  contributions: {
    modules: [
      {
        id: 'demo.catalog',
        title: '应用目录',
        route: '/catalog',
        mount: async (target) => {
          log.push('mount');
          const node = target.ownerDocument.createElement('section');
          node.dataset.modulePage = '';
          node.textContent = '插件页面';
          target.append(node);
          return () => {
            log.push('release');
            node.remove();
          };
        },
      },
    ],
  },
});

// 模块没有 slot 字段：它的页面槽位由 pluginId + route 派生，必须和路由键算出同一个字符串。
test('插件模块派生的页面槽位：装载即接管，卸载回落到占位', { timeout: 90_000 }, async () => {
  const browser = installBrowser();
  const { document } = browser.windowRef;
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  const adapter = await createNamedSlotAdapter([]);
  const runtime = createFrontendRuntime({
    baseUrl: 'http://localhost:7031',
    panelTarget: () => null,
    transport: async () => success(job()),
    slotAdapter: adapter,
  });
  const services = { runtime } as unknown as ProductServices;
  const target = document.getElementById('test-app');
  assert.ok(target);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(target);
  const log: string[] = [];
  const flush = async (steps = 3) => {
    for (let index = 0; index < steps; index += 1)
      await act(async () => {
        await Promise.resolve();
      });
  };
  try {
    const loaded: unknown = await server.ssrLoadModule('/src/app/product/slots.tsx');
    assert.ok(surfaceModule(loaded));
    runtime.webPlugins.register({ id: 'demo', trusted: true, plugin: modulePlugin(log) });
    await act(async () => {
      await runtime.webPlugins.load('demo');
    });
    await act(async () => {
      root.render(
        createElement(loaded.ExtensionSurface, {
          services,
          slot: 'page.demo.catalog',
          fill: true,
          fallback: createElement('div', { 'data-host-page': '' }, '宿主占位'),
        }),
      );
    });
    await flush();
    assert.equal(target.querySelector('[data-module-page]')?.textContent, '插件页面');
    assert.deepEqual(log, ['mount']);
    assert.match(target.textContent ?? '', /应用目录/, '接管态必须标出这是哪个插件页面');

    await act(async () => {
      await runtime.webPlugins.unload('demo');
    });
    await flush();
    assert.equal(target.querySelector('[data-host-page]')?.textContent, '宿主占位');
    assert.deepEqual(log, ['mount', 'release']);
  } finally {
    await act(async () => {
      root.unmount();
    });
    await runtime.dispose();
    await adapter.dispose();
    await server.close();
    browser.restore();
  }
});
