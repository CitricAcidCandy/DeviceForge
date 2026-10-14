import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { act } from 'react';
import { createServer } from 'vite';
import type { ViteDevServer } from 'vite';
import { JSDOM } from 'jsdom';
import { createProductServices } from '../src/app/product/services.ts';
import type { startFrontendApp } from '../src/app/main.ts';
import { deferred, installedPackage, plugin, requestUrl, success } from './fixtures.ts';

type StartedApp = Awaited<ReturnType<typeof startFrontendApp>>;
type MainModule = { startFrontendApp: typeof startFrontendApp };
let server: ViteDevServer | null = null;
let main: MainModule | null = null;
function mainModule(value: unknown): value is MainModule {
  return (
    value !== null &&
    typeof value === 'object' &&
    'startFrontendApp' in value &&
    typeof value.startFrontendApp === 'function'
  );
}
async function loadMain(): Promise<MainModule> {
  if (main) return main;
  // 首次加载时测试文档还没有 #app，入口自动启动会无挂载目标退出；随后显式启动一次。
  server ??= await createServer({
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
  });
  const loaded: unknown = await server.ssrLoadModule('/src/app/main.ts');
  assert.ok(mainModule(loaded));
  main = loaded;
  return loaded;
}
after(async () => {
  await server?.close();
});

function installDom(browser: JSDOM) {
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
    location: windowRef.location,
    Element: windowRef.Element,
    DocumentFragment: windowRef.DocumentFragment,
    HTMLElement: windowRef.HTMLElement,
    HTMLFormElement: windowRef.HTMLFormElement,
    HTMLInputElement: windowRef.HTMLInputElement,
    HTMLSelectElement: windowRef.HTMLSelectElement,
    HTMLTextAreaElement: windowRef.HTMLTextAreaElement,
    Node: windowRef.Node,
    NodeFilter: windowRef.NodeFilter,
    MutationObserver: windowRef.MutationObserver,
    Event: windowRef.Event,
    getComputedStyle: windowRef.getComputedStyle.bind(windowRef),
    HTMLButtonElement: windowRef.HTMLButtonElement,
    HTMLAnchorElement: windowRef.HTMLAnchorElement,
    HTMLIFrameElement: windowRef.HTMLIFrameElement,
    FocusEvent: windowRef.FocusEvent,
    KeyboardEvent: windowRef.KeyboardEvent,
    MouseEvent: windowRef.MouseEvent,
    PointerEvent: windowRef.MouseEvent,
    requestAnimationFrame: windowRef.requestAnimationFrame.bind(windowRef),
    cancelAnimationFrame: windowRef.cancelAnimationFrame.bind(windowRef),
    CustomEvent: windowRef.CustomEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const descriptors = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  return () => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}
async function withMain(
  transport: typeof fetch,
  verify: (app: StartedApp, browser: JSDOM) => Promise<void>,
  initialRoute = '',
) {
  const browser = new JSDOM(
    '<!doctype html><html><body><div id="startup-test-target"></div></body></html>',
    { url: `http://localhost:7031${initialRoute}`, pretendToBeVisual: true },
  );
  Object.defineProperty(browser.window, 'fetch', { configurable: true, value: transport });
  const restore = installDom(browser);
  const loaded = await loadMain();
  const target = browser.window.document.getElementById('startup-test-target');
  assert.ok(target);
  target.id = 'app';
  const windowRef = browser.window.document.defaultView;
  assert.ok(windowRef);
  const started: { app: StartedApp | null } = { app: null };
  try {
    await act(async () => {
      started.app = await loaded.startFrontendApp(browser.window.document, windowRef);
    });
    assert.ok(started.app);
    await verify(started.app, browser);
  } finally {
    if (started.app)
      await act(async () => {
        await started.app?.dispose();
      });
    restore();
    browser.window.close();
  }
}
async function settled(condition: () => boolean, message: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
  }
  assert.ok(condition(), message);
}
async function navigate(browser: JSDOM, route: string) {
  const button = browser.window.document.querySelector(`button[data-navigation-route="${route}"]`);
  assert.ok(button instanceof browser.window.HTMLButtonElement, `缺少路由 ${route}`);
  await act(async () => button.click());
}

test('独立产品服务工厂构造与关闭保持零网络，默认启用只由生产启动入口触发', async () => {
  let calls = 0;
  const services = createProductServices({
    baseUrl: 'http://localhost:7031',
    panelTarget: () => null,
    transport: async () => {
      calls += 1;
      throw new Error('独立工厂不应请求');
    },
  });
  assert.equal(services.pluginDefaults.snapshot().phase, 'idle');
  await services.dispose();
  assert.equal(calls, 0);
});

test('生产入口读取两类安装目录和运行插件，已运行服务器不重复加载，真实ESM导入失败保留App', async () => {
  const requests: string[] = [];
  const transport: typeof fetch = async (input, init) => {
    const path = requestUrl(input).pathname;
    requests.push(`${init?.method ?? 'GET'} ${path}`);
    if (path === '/api/v2/plugins')
      return success([plugin({ id: 'running-server' })], 'running-log');
    if (path === '/api/v2/plugin-packages/server')
      return success(
        [installedPackage('server', { id: 'running-server', runtime: 'process' })],
        'server-directory-log',
      );
    if (path === '/api/v2/plugin-packages/browser')
      return success(
        [installedPackage('browser', { id: 'broken-browser', api_version: 2 })],
        'browser-directory-log',
      );
    return success([]);
  };
  await withMain(transport, async (app, browser) => {
    await settled(
      () => requests.filter((value) => value.endsWith('/plugin-packages/browser')).length >= 2,
      '生产入口应尝试启用已安装浏览器包',
    );
    await navigate(browser, 'plugins');
    await settled(() => {
      const status = browser.window.document.querySelector('[aria-label="已安装插件默认启用"]');
      return (
        status?.textContent?.includes('broken-browser') === true &&
        status.textContent.includes('启用失败')
      );
    }, '默认启用页面应展示实际导入器的加载失败状态');
    const status = browser.window.document.querySelector('[aria-label="已安装插件默认启用"]');
    assert.ok(status);
    assert.match(status.textContent ?? '', /running-server/);
    assert.ok(
      status.querySelector(
        '[data-default-plugin-id="running-server"][data-default-plugin-status="already_enabled"]',
      ),
    );
    assert.ok(
      status.querySelector(
        '[data-default-plugin-id="broken-browser"][data-default-plugin-status="failed"]',
      ),
    );
    assert.match(status.textContent ?? '', /broken-browser/);
    assert.match(browser.window.document.body.textContent ?? '', /设备工坊/);
    assert.equal(
      requests.some((value) => value.startsWith('POST ') && value.includes('/load')),
      false,
    );
    assert.ok(requests.some((value) => value.endsWith('/api/v2/plugins')));
    assert.ok(requests.some((value) => value.endsWith('/plugin-packages/server')));
    assert.ok(requests.some((value) => value.endsWith('/plugin-packages/browser')));
    assert.ok(app.runtime);
    assert.equal(
      app.runtime.webPlugins
        .snapshot()
        .some((item) => item.id === 'broken-browser' && item.state === 'loaded'),
      false,
    );
  });
});

test('生产入口关闭取消旧默认目录等待，晚到响应不再加载任何包', async () => {
  const waiting = deferred<Response>();
  const started = deferred<AbortSignal | null | undefined>();
  const requests: string[] = [];
  const transport: typeof fetch = async (input, init) => {
    const path = requestUrl(input).pathname;
    requests.push(path);
    if (path === '/api/v2/plugins') {
      started.resolve(init?.signal);
      return waiting.promise;
    }
    return success([]);
  };
  await withMain(transport, async (app, browser) => {
    const current = await started.promise;
    await act(async () => {
      await app.dispose();
    });
    assert.equal(current?.aborted, true);
    waiting.resolve(success([plugin()]));
    await act(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
    assert.equal(
      requests.some((path) => path.includes('/plugin-packages/')),
      false,
    );
    assert.equal(browser.window.document.getElementById('product-root'), null);
    assert.equal(browser.window.document.querySelector('.plugin-extension-root'), null);
  });
});

test('首路由插件页等待默认启用完成，不撤销延迟运行查询，并实际加载尚未运行的服务器包', async () => {
  const initialRunning = deferred<Response>();
  const started = deferred<AbortSignal | null | undefined>();
  const requests: string[] = [];
  let runningQueries = 0;
  let loaded = false;
  const transport: typeof fetch = async (input, init) => {
    const path = requestUrl(input).pathname;
    requests.push(`${init?.method ?? 'GET'} ${path}`);
    if (path === '/api/v2/plugins') {
      runningQueries += 1;
      if (runningQueries === 1) {
        started.resolve(init?.signal);
        return initialRunning.promise;
      }
      return success(loaded ? [plugin({ id: 'startup-server' })] : [], 'running-query-log');
    }
    if (path === '/api/v2/plugin-packages/server')
      return success([installedPackage('server', { id: 'startup-server', runtime: 'process' })]);
    if (path === '/api/v2/plugins/startup-server/load') {
      assert.equal(init?.method, 'POST');
      loaded = true;
      return success(plugin({ id: 'startup-server' }), 'startup-load-log');
    }
    return success([]);
  };
  await withMain(
    transport,
    async (app, browser) => {
      const current = await started.promise;
      const status = browser.window.document.querySelector('[data-plugin-defaults]');
      assert.ok(status);
      assert.equal(status.getAttribute('data-plugin-defaults'), 'running');
      const refresh = Array.from(browser.window.document.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === '刷新目录',
      );
      assert.ok(refresh);
      assert.equal(refresh.disabled, true);
      await act(async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
      });
      assert.equal(runningQueries, 1, '插件页不能额外读取并撤销默认启用的运行查询');
      assert.equal(current?.aborted, false);
      await act(async () => {
        initialRunning.resolve(success([], 'initial-running-log'));
      });
      await settled(
        () => status.getAttribute('data-plugin-defaults') === 'completed' && !refresh.disabled,
        '默认启用应完成，页面刷新入口应恢复',
      );
      assert.equal(
        requests.filter((request) => request === 'POST /api/v2/plugins/startup-server/load').length,
        1,
      );
      assert.ok(
        status.querySelector(
          '[data-default-plugin-id="startup-server"][data-default-plugin-status="enabled"]',
        ),
      );
      assert.equal(status.querySelector('[data-default-plugin-status="failed"]'), null);
      assert.ok(app.runtime);
      assert.equal(
        app.runtime.serverPlugins
          .snapshot()
          .result?.data.some((item) => item.id === 'startup-server' && item.state === 'loaded'),
        true,
      );
      const previousQueries = runningQueries;
      await act(async () => refresh.click());
      await settled(
        () => runningQueries > previousQueries && !refresh.disabled,
        '默认启用完成后仍可手动刷新目录',
      );
      assert.equal(
        requests.filter((request) => request === 'POST /api/v2/plugins/startup-server/load').length,
        1,
      );
      assert.equal(status.getAttribute('data-plugin-defaults'), 'completed');
    },
    '#plugins',
  );
});

test('通过真实设置页切换服务撤销旧默认等待，新服务重新读取默认目录', async () => {
  const waiting = deferred<Response>();
  const started = deferred<AbortSignal | null | undefined>();
  const requests: { origin: string; path: string }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = requestUrl(input);
    requests.push({ origin: url.origin, path: url.pathname });
    if (url.origin === 'http://localhost:7031' && url.pathname === '/api/v2/plugins') {
      started.resolve(init?.signal);
      return waiting.promise;
    }
    return success([]);
  };
  await withMain(transport, async (app, browser) => {
    const current = await started.promise;
    const oldRuntime = app.runtime;
    await navigate(browser, 'settings');
    const label = Array.from(browser.window.document.querySelectorAll('label')).find(
      (item) => item.textContent === '服务地址',
    );
    assert.ok(label?.htmlFor);
    const input = browser.window.document.getElementById(label.htmlFor);
    assert.ok(input instanceof browser.window.HTMLInputElement);
    const setValue = Object.getOwnPropertyDescriptor(
      browser.window.HTMLInputElement.prototype,
      'value',
    )?.set;
    assert.ok(setValue);
    await act(async () => {
      setValue.call(input, 'http://localhost:7042');
      input.dispatchEvent(new browser.window.Event('input', { bubbles: true }));
    });
    const apply = Array.from(browser.window.document.querySelectorAll('button')).find(
      (item) => item.textContent?.trim() === '测试并应用',
    );
    assert.ok(apply);
    await act(async () => apply.click());
    await settled(
      () =>
        app.runtime !== oldRuntime &&
        requests.some(
          (item) =>
            item.origin === 'http://localhost:7042' &&
            item.path === '/api/v2/plugin-packages/browser',
        ),
      '服务切换应构造新实例并重新读取两类包目录',
    );
    assert.equal(current?.aborted, true);
    waiting.resolve(success([plugin()]));
    await act(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
    assert.equal(
      requests.some(
        (item) =>
          item.origin === 'http://localhost:7031' && item.path.includes('/plugin-packages/'),
      ),
      false,
    );
    assert.match(browser.window.document.body.textContent ?? '', /设备工坊/);
  });
});
