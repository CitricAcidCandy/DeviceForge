import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { runInNewContext } from 'node:vm';
import test, { after } from 'node:test';
import { JSDOM } from 'jsdom';
import * as React from 'react';
import { act, createElement } from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import ts from 'typescript';
import type { ComponentType, ReactNode } from 'react';
import { createFrontendRuntime } from '../src/app/index.ts';
import { createNamedSlotAdapter } from '../src/plugins/index.ts';
import type { ProductServices } from '../src/app/product/services.ts';
import { createProductServices } from '../src/app/product/services.ts';
import type { PluginDefaultsSnapshot } from '../src/features/plugin-defaults/index.ts';
import type { ComponentInfo, ExtensionCatalog, SlotHost, WebPlugin } from '../src/plugin-sdk/index.ts';
import * as routes from '../src/app/product/routes.ts';
import { deferred, job, success } from './fixtures.ts';

// 直接转译 TSX，复用同一份 React；不启动 Vite，不争用其它代理的依赖缓存。
const loader = registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith('file:') && url.endsWith('.tsx')) return {
      shortCircuit: true, format: 'module',
      source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        fileName: url,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
      }).outputText,
    };
    return nextLoad(url, context);
  },
});
after(() => loader.deregister());

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

test('路由槽位：插件接管整页、恢复默认回落后再启用、卸载插件自动复原', { timeout: 10_000 }, async () => {
  const browser = installBrowser();
  const { document } = browser.windowRef;
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
    const loaded: unknown = await import('../src/app/product/slots.tsx');
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
test('插件模块派生的页面槽位：装载即接管，卸载回落到占位', { timeout: 10_000 }, async () => {
  const browser = installBrowser();
  const { document } = browser.windowRef;
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
    const loaded: unknown = await import('../src/app/product/slots.tsx');
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
    browser.restore();
  }
});

async function surfaceFixture(options: { host?: SlotHost; mode?: 'replace' | 'append'; kind?: 'component' | 'module' } = {}) {
  const browser = installBrowser();
  const base = createProductServices({ baseUrl: 'http://localhost:7031', panelTarget: () => null, transport: async () => success(job()) });
  const entry = (generation: number): ComponentInfo => ({
    id: 'demo.pane', pluginId: 'demo', generation, title: '测试接管者',
    slot: 'route.performance', mode: options.mode ?? 'replace',
  });
  const catalogAt = (generation: number): ExtensionCatalog => ({
    components: options.kind === 'module' ? [] : [entry(generation)],
    modules: options.kind === 'module' ? [{
      id: 'demo.pane', pluginId: 'demo', generation, title: '测试模块', route: '/catalog',
    }] : [],
    commands: [], services: [],
  });
  let catalog = catalogAt(1);
  const listeners = new Set<() => void>();
  const calls: string[] = [];
  const mounts: ReturnType<typeof deferred<void>>[] = [];
  const mount = (id: string) => {
    calls.push(`mount:${id}:${catalog.components[0]?.generation ?? catalog.modules[0]?.generation}`);
    const pending = deferred<void>();
    mounts.push(pending);
    return pending.promise;
  };
  const host: SlotHost = options.host ?? { define: async () => () => undefined };
  const services: ProductServices = {
    ...base,
    runtime: { ...base.runtime, extensions: {
      ...base.runtime.extensions, slots: host,
      catalog: () => catalog,
      subscribe(notify) { listeners.add(notify); return () => { listeners.delete(notify); }; },
      mountComponent: mount,
      mountModule: mount,
      async unmount(id) { calls.push(`unmount:${id}`); },
    } },
  };
  const container = browser.windowRef.document.getElementById('test-app');
  assert.ok(container);
  const { createRoot } = await import('react-dom/client');
  const { ExtensionSurface } = await import('../src/app/product/slots.tsx');
  const root = createRoot(container);
  const flush = async () => {
    for (let step = 0; step < 4; ++step) await act(async () => { await Promise.resolve(); });
  };
  return {
    container, calls, mounts, flush,
    fallback: () => container.querySelector('[data-host-fallback]') !== null,
    async render() {
      await act(async () => { root.render(createElement(ExtensionSurface, {
        services, slot: options.kind === 'module' ? 'page.demo.catalog' : 'route.performance',
        fallback: createElement('p', { 'data-host-fallback': '' }, '宿主回落'),
      })); });
      await flush();
    },
    async generation(value: number) {
      await act(async () => {
        catalog = catalogAt(value);
        for (const listener of listeners) listener();
      });
      await flush();
    },
    async close() {
      await act(async () => { root.unmount(); });
      await base.dispose();
      browser.restore();
    },
  };
}

test('替换挂载等待期间保留 fallback，仅成功后让位', async () => {
  const fixture = await surfaceFixture();
  try {
    await fixture.render();
    assert.equal(fixture.fallback(), true, '尚未接管成功必须保留宿主');
    assert.equal(fixture.mounts.length, 1);
    await act(async () => { fixture.mounts[0]?.resolve(); });
    await fixture.flush();
    assert.equal(fixture.fallback(), false);
  } finally { await fixture.close(); }
});

test('槽位登记失败与替换挂载失败都保留 fallback 和告警', async (t) => {
  for (const failure of ['define', 'mount'] as const) await t.test(failure, async () => {
    const fixture = await surfaceFixture(failure === 'define' ? {
      host: { define: async () => { throw new Error('登记失败'); } },
    } : {});
    try {
      await fixture.render();
      if (failure === 'mount') {
        await act(async () => { fixture.mounts[0]?.reject(new Error('挂载失败')); });
        await fixture.flush();
      }
      assert.equal(fixture.fallback(), true);
      assert.equal(fixture.container.querySelector('[role="alert"]') !== null, true);
    } finally { await fixture.close(); }
  });
});

test('同 ID 代次替换重新挂载，旧代晚到成功不能隐藏新代 fallback', async (t) => {
  for (const kind of ['component', 'module'] as const) await t.test(kind, async () => {
    const fixture = await surfaceFixture({ kind });
    try {
      await fixture.render();
      await fixture.generation(2);
      assert.equal(fixture.mounts.length, 2, '新 generation 必须重新挂载');
      await act(async () => { fixture.mounts[0]?.resolve(); });
      await fixture.flush();
      assert.equal(fixture.fallback(), true, '旧代成功不能充当新代成功');
      await act(async () => { fixture.mounts[1]?.resolve(); });
      await fixture.flush();
      assert.equal(fixture.fallback(), false);
      await fixture.generation(3);
      assert.equal(fixture.fallback(), true, '已成功旧代也必须立即让回宿主');
      assert.equal(fixture.mounts.length, 3);
    } finally { await fixture.close(); }
  });
});

test('追加贡献同 ID 热重载按完整代次重新挂载，旧失败不能污染新代', async () => {
  const fixture = await surfaceFixture({ mode: 'append' });
  try {
    await fixture.render();
    await fixture.generation(2);
    assert.equal(fixture.mounts.length, 2);
    await act(async () => { fixture.mounts[0]?.reject(new Error('旧代失败')); });
    await fixture.flush();
    assert.equal(fixture.container.querySelector('[role="alert"]') === null, true);
    assert.equal(fixture.fallback(), true, '追加贡献始终保留宿主');
  } finally { await fixture.close(); }
});

// 执行真实 App，只替换外壳/业务页和槽位展示；避免为路由断言加载设备与图表业务。
function appModule(pages: () => readonly { key: routes.PluginRoute }[]) {
  const passthrough = ({ children }: { children?: ReactNode }) => children;
  const page = () => createElement('p', { 'data-device-page': '' }, '设备页');
  const imports: Readonly<Record<string, unknown>> = {
    react: React, 'react/jsx-runtime': jsxRuntime, './routes.ts': routes,
    './shell.tsx': { ProductShell: passthrough },
    './slots.tsx': { usePluginPages: pages, RouteSurface: passthrough },
    '../../pages/devices/index.tsx': { DevicesPage: page },
    '../../pages/tasks/index.tsx': { TasksPage: page },
    '../../pages/settings/index.tsx': { SettingsPage: page },
    '../../pages/marketplace/index.tsx': { MarketplacePage: page },
    './advanced.tsx': { AdvancedPage: page },
    '../../components/Message/index.tsx': { MessageProvider: passthrough },
  };
  const exported: Record<string, unknown> = {};
  const source = ts.transpileModule(readFileSync(new URL('../src/app/product/App.tsx', import.meta.url), 'utf8'), {
    fileName: 'App.tsx', compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  runInNewContext(source, {
    exports: exported, window: globalThis.window,
    require(id: string) {
      if (!(id in imports)) throw new Error(`未声明的 App 测试依赖：${id}`);
      return imports[id];
    },
  });
  const isApp = (value: unknown): value is React.ComponentType<{ services: ProductServices }> => typeof value === 'function';
  const App = exported.App;
  assert.ok(isApp(App));
  return App;
}

test('App 直达插件页面等待启动完成；目录出现后保留，卸载才回设备', async () => {
  const browser = installBrowser();
  const base = createProductServices({ baseUrl: 'http://localhost:7031', panelTarget: () => null, transport: async () => success(job()) });
  const key = routes.pluginRoute('demo', 'catalog');
  browser.windowRef.location.hash = `#/${routes.routeHash(key)}`;
  let pages: readonly { key: routes.PluginRoute }[] = [];
  let snapshot: PluginDefaultsSnapshot = { round: 0, phase: 'idle', results: [] };
  const listeners = new Set<(snapshot: PluginDefaultsSnapshot) => void>();
  const services: ProductServices = { ...base, pluginDefaults: {
    ...base.pluginDefaults, snapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  } };
  const App = appModule(() => pages);
  const container = browser.windowRef.document.getElementById('test-app');
  assert.ok(container);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container);
  const render = async () => {
    await act(async () => { root.render(createElement(App, { services })); });
  };
  const phase = async (value: PluginDefaultsSnapshot['phase']) => {
    await act(async () => {
      snapshot = { ...snapshot, phase: value };
      for (const listener of listeners) listener(snapshot);
    });
  };
  try {
    await render();
    assert.match(browser.windowRef.location.hash, /plugin\/demo\/catalog$/, 'idle 不能抢先重定向');
    await phase('running');
    assert.match(browser.windowRef.location.hash, /plugin\/demo\/catalog$/);
    pages = [{ key }];
    await render();
    await phase('completed');
    assert.match(browser.windowRef.location.hash, /plugin\/demo\/catalog$/);
    pages = [];
    await render();
    assert.equal(browser.windowRef.location.hash, '#devices');
    assert.equal(container.querySelector('[data-device-page]') !== null, true);
  } finally {
    await act(async () => { root.unmount(); });
    await base.dispose();
    browser.restore();
  }
});

test('App 启动完成后仍缺失的插件直达路由才回设备', async () => {
  const browser = installBrowser();
  const services = createProductServices({ baseUrl: 'http://localhost:7031', panelTarget: () => null, transport: async () => success(job()) });
  const completed: PluginDefaultsSnapshot = { round: 1, phase: 'completed', results: [] };
  const configured: ProductServices = { ...services, pluginDefaults: { ...services.pluginDefaults, snapshot: () => completed } };
  browser.windowRef.location.hash = '#/plugin/missing/catalog';
  const App = appModule(() => []);
  const container = browser.windowRef.document.getElementById('test-app');
  assert.ok(container);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(App, { services: configured })); });
    assert.equal(browser.windowRef.location.hash, '#devices');
  } finally {
    await act(async () => { root.unmount(); });
    await services.dispose();
    browser.restore();
  }
});
