import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { act } from 'react';
import { createServer } from 'vite';
import type { ViteDevServer } from 'vite';
import { JSDOM } from 'jsdom';
import { createProductServices } from '../src/app/product/services.ts';
import type { SessionInfo } from '../src/services/api/index.ts';
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
async function settled(condition: () => boolean, message: string, detail?: () => string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
  }
  assert.ok(condition(), detail ? `${message}；当前状态：${detail()}` : message);
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
    if (path === '/api/v2/plugin-dependencies/browser/broken-browser')
      return success({ target: { kind: 'browser', id: 'broken-browser' },
        revision: 'a'.repeat(64), ready: true, dependencies: [] }, 'dependency-log');
    return success([]);
  };
  await withMain(transport, async (app, browser) => {
    await settled(
      () => requests.filter((value) => value.endsWith('/plugin-packages/browser')).length >= 2,
      '生产入口应尝试启用已安装浏览器包',
    );
    await navigate(browser, 'marketplace');
    await settled(
      () => browser.window.document.querySelector('[data-message-id="plugin-default-failures"]') !== null,
      '生产入口应通过统一消息展示真实导入器失败',
    );
    const status = browser.window.document.querySelector('[data-message-id="plugin-default-failures"]');
    assert.ok(status);
    assert.match(status.querySelector('[data-message-details]')?.textContent ?? '', /broken-browser/);
    assert.match(browser.window.document.body.textContent ?? '', /设备工坊/);
    assert.equal(
      requests.some((value) => value.startsWith('POST ') && value.includes('/load')),
      false,
    );
    assert.ok(requests.some((value) => value.endsWith('/api/v2/plugins')));
    assert.ok(requests.some((value) => value.endsWith('/plugin-packages/server')));
    assert.ok(requests.some((value) => value.endsWith('/plugin-packages/browser')));
    assert.ok(app.runtime);
    assert.ok(app.runtime.serverPlugins.snapshot().result?.data.some((item) => item.id === 'running-server'));
    assert.equal(
      app.runtime.webPlugins
        .snapshot()
        .some((item) => item.id === 'broken-browser' && item.state === 'loaded'),
      false,
    );
  });
});

test('终端页面以PTY协议创建会话，自动分页、暂停续读并关闭', { timeout: 90_000 }, async () => {
  const id = '12345678-1234-1234-1234-123456789abc';
  let current: SessionInfo = {
    id,
    operation: 'plugin.terminal.open',
    plugin_id: 'terminal',
    generation: 'terminal-generation',
    created_at: 1,
    status: 'opening',
    output_sequence: 0,
    completion: null,
  };
  const chunks = Array.from({ length: 55 }, (_, index) => ({
    sequence: index + 1,
    stream: 'stdout',
    bytes: [...new TextEncoder().encode(`终端输出 ${index + 1}\n`)],
  }));
  const reads: { after: number; limit: number; signal: AbortSignal | null }[] = [];
  const waiting = deferred<Response>();
  let configuredProfile = 'python';
  let opens = 0;
  let cancels = 0;
  const transport: typeof fetch = async (input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    if (url.pathname === '/api/v2/session-definitions')
      return success({
        revision: 1,
        sessions: [{
          id: 'plugin.terminal.open',
          title: '终端',
          input_schema: { type: 'object' },
          execution: { api_version: 1, source: 'declared', total_timeout_ms: 60_000 },
        }],
      });
    if (url.pathname === '/api/v2/plugin-configurations/server/terminal')
      return success({
        kind: 'server', id: 'terminal', definition: null,
        values: { profiles: { [configuredProfile]: { executable: 'fixture-shell', args: [] } } },
        revision: 0, applied_revision: 0, pending_reload: false,
        compatible: true, source: 'managed', field_errors: [],
      });
    if (url.pathname === '/api/v2/sessions' && method === 'POST') {
      assert.deepEqual(JSON.parse(String(init?.body)), {
        operation: 'plugin.terminal.open', input: {
          profile: 'powershell',
          terminal: { protocol: 'deviceforge.terminal.v1', cols: 120, rows: 30 },
        },
      });
      opens += 1;
      return success(current, 'terminal-open-log');
    }
    if (url.pathname === `/api/v2/sessions/${id}/output`) {
      const after = Number(url.searchParams.get('after'));
      const limit = Number(url.searchParams.get('limit'));
      assert.ok(Number.isSafeInteger(after) && after >= 0);
      assert.ok(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100);
      reads.push({ after, limit, signal: init?.signal ?? null });
      if (after >= chunks.length) return waiting.promise;
      const selected = chunks.filter((chunk) => chunk.sequence > after).slice(0, limit);
      return success({
        session: { ...current, output_sequence: chunks.length },
        chunks: selected,
        next_sequence: selected.at(-1)?.sequence ?? after,
      }, 'terminal-output-log');
    }
    if (url.pathname === `/api/v2/sessions/${id}/input`) {
      return success({ id, accepted: true }, 'terminal-input-log');
    }
    if (url.pathname === `/api/v2/sessions/${id}/cancel`) {
      cancels += 1;
      current = {
        ...current, status: 'finished', output_sequence: chunks.length,
        completion: {
          outcome: { result: null, error: null, artifacts: [] },
          cleanup: 'complete', process_exited: true, sequence: chunks.length + 1, failure: null,
        },
      };
      return success(current, 'terminal-cancel-log');
    }
    return success([]);
  };
  await withMain(transport, async (_app, browser) => {
    const documentRef = browser.window.document;
    const button = (label: string) => {
      const found = Array.from(documentRef.querySelectorAll('button')).find(
        (entry) => entry.getAttribute('aria-label') === label || entry.textContent?.trim() === label,
      );
      assert.ok(found, `缺少终端操作：${label}`);
      return found;
    };
    await navigate(browser, 'terminal');
    await settled(() => !button('新会话').disabled, '终端目录和档案未就绪');
    configuredProfile = 'powershell';
    await act(async () => button('刷新目录').click());
    await settled(() =>
      documentRef.querySelector('[data-product-page="terminal"] header')?.textContent?.includes('powershell') ?? false,
      '刷新后应选中新的命令行档案，不能保留已移除的Python',
    );
    await act(async () => button('新会话').click());
    await settled(() => reads.length >= 3, '创建会话后没有持续读取输出');
    assert.equal(opens, 1);
    assert.deepEqual(reads.slice(0, 3).map(({ after }) => after), [0, 50, 55]);
    assert.ok(documentRef.querySelector('[aria-label="终端输出"]'));
    assert.ok(documentRef.body.textContent?.includes('游标 55'));
    await act(async () => button('暂停读取输出').click());
    assert.equal(reads.at(-1)?.signal?.aborted, true);
    assert.equal(cancels, 0, '暂停读取不能停止服务器会话');
    await act(async () => button('继续读取输出').click());
    await settled(() => reads.length >= 4, '暂停后继续读取没有请求输出');
    assert.equal(reads.at(-1)?.after, 55);
    // 原始按键由真实浏览器验收；这里验证页面编排与公开PTY打开契约。
    await act(async () => button('关闭会话').click());
    await settled(() => button('关闭会话').disabled, '关闭后终端没有显示终态');
    assert.equal(cancels, 1);
    assert.ok(documentRef.body.textContent?.includes('清理完成'));
    assert.equal(documentRef.querySelector('[data-message-kind="error"]'), null);
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

test('首路由市场页等待默认启用完成，不撤销延迟运行查询，并实际加载尚未运行的服务器包', async () => {
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
      const refresh = Array.from(browser.window.document.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === '刷新',
      );
      assert.ok(refresh);
      await act(async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
      });
      assert.equal(runningQueries, 1, '市场页不能额外读取并撤销默认启用的运行查询');
      assert.equal(current?.aborted, false);
      await act(async () => {
        initialRunning.resolve(success([], 'initial-running-log'));
      });
      await settled(
        () => Boolean(app.runtime?.serverPlugins.snapshot().result?.data.some((item) => item.id === 'startup-server' && item.state === 'loaded')) && !refresh.disabled,
        '默认启用应完成，页面刷新入口应恢复',
      );
      assert.equal(
        requests.filter((request) => request === 'POST /api/v2/plugins/startup-server/load').length,
        1,
      );
      assert.equal(browser.window.document.querySelector('[data-message-id="plugin-default-failures"]'), null);
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
      assert.equal(browser.window.document.querySelector('[data-message-id="plugin-default-failures"]'), null);
    },
    '#marketplace',
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
