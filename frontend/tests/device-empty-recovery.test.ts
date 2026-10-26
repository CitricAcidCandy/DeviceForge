import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { act, createElement, StrictMode } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import { createProductServices } from '../src/app/product/services.ts';
import type { DeviceDirectoryDto, DeviceProviderDto, PluginRecoveryView } from '../src/services/api/index.ts';
import { directory, provider } from './device-fixtures.ts';
import { deferred, requestUrl, signal, success } from './fixtures.ts';

function recoveryView(recovered = false): PluginRecoveryView {
  return {
    id: 'mirroring', generation: 'recovery-g1', supported: true,
    cleanup_failed: !recovered, recovering: false,
    last_report: recovered ? {
      status: 'recovered', coverage: 'plugin', inspected: 1, remaining: 0,
      message: '全部资源已确认',
      checks: [{ resource: 'control', status: 'confirmed', message: '控制资源已确认' }],
    } : null,
  };
}

async function settled(condition: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100 && !condition(); attempt++)
    await act(async () => { await new Promise<void>((done) => setImmediate(done)); });
  assert.ok(condition(), message);
}

test('真实设备页父级在空态保留全插件恢复入口（无服务、无真实设备）', async (t) => {
  const loader = registerHooks({
    load(url, context, nextLoad) {
      if (url.startsWith('file:') && url.endsWith('.tsx')) return {
        shortCircuit: true, format: 'module',
        source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
          fileName: url,
          compilerOptions: {
            target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
            jsx: ts.JsxEmit.ReactJSX,
          },
        }).outputText,
      };
      if (url.endsWith('.css')) return { shortCircuit: true, format: 'module', source: '' };
      return nextLoad(url, context);
    },
  });
  const browser = new JSDOM('<!doctype html><html><body><main id="empty-recovery"></main></body></html>', {
    url: 'http://localhost/', pretendToBeVisual: true,
  });
  const windowRef = browser.window;
  const globals: Readonly<Record<string, unknown>> = {
    window: windowRef, document: windowRef.document, navigator: windowRef.navigator,
    Element: windowRef.Element, HTMLElement: windowRef.HTMLElement, Node: windowRef.Node,
    DocumentFragment: windowRef.DocumentFragment, MutationObserver: windowRef.MutationObserver,
    HTMLInputElement: windowRef.HTMLInputElement, HTMLSelectElement: windowRef.HTMLSelectElement,
    HTMLTextAreaElement: windowRef.HTMLTextAreaElement, HTMLFormElement: windowRef.HTMLFormElement,
    HTMLButtonElement: windowRef.HTMLButtonElement, HTMLVideoElement: windowRef.HTMLVideoElement,
    HTMLCanvasElement: windowRef.HTMLCanvasElement,
    Event: windowRef.Event, CustomEvent: windowRef.CustomEvent,
    getComputedStyle: windowRef.getComputedStyle.bind(windowRef),
    requestAnimationFrame: windowRef.requestAnimationFrame.bind(windowRef),
    cancelAnimationFrame: windowRef.cancelAnimationFrame.bind(windowRef),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const target = windowRef.document.getElementById('empty-recovery');
  assert.ok(target);
  const { createRoot } = await import('react-dom/client');
  const { DevicesPage } = await import('../src/pages/devices/index.tsx');
  const root = createRoot(target);
  const button = (label: string) => {
    const value = Array.from(target.querySelectorAll('button')).find((item) => item.textContent?.trim() === label);
    assert.ok(value, `缺少按钮：${label}`);
    return value;
  };
  function page(options: {
    providers?: readonly DeviceProviderDto[];
    directories?: readonly DeviceDirectoryDto[];
    holdRead?: boolean;
    holdPost?: boolean;
    holdDirectories?: boolean;
  } = {}) {
    const requests: { path: string; method: string; body: unknown; signal: AbortSignal | null }[] = [];
    const firstRead = deferred<Response>(), post = deferred<Response>(), directories = deferred<Response>();
    let latest = recoveryView(), reads = 0;
    const services = createProductServices({
      baseUrl: 'http://localhost', panelTarget: () => target,
      transport: async (input, init) => {
        const path = requestUrl(input).pathname;
        requests.push({ path, method: init?.method ?? 'GET',
          body: init?.body ? JSON.parse(String(init.body)) : null, signal: init?.signal ?? null });
        if (path === '/api/v2/plugins/mirroring/recovery') {
          if (init?.method === 'POST') {
            if (options.holdPost) return post.promise;
            latest = recoveryView(true);
          } else if (++reads === 1 && options.holdRead) return firstRead.promise;
          return success(latest);
        }
        if (path === '/api/v2/device-providers') return success(options.providers ?? []);
        if (path === '/api/v2/devices') return options.holdDirectories ? directories.promise : success(options.directories ?? []);
        if (path === '/api/v2/session-definitions') return success({ revision: 1, sessions: [] });
        throw new Error(`禁止额外业务请求：${path}`);
      },
    });
    return {
      services, requests, firstRead, post, directories,
      async render(active = true, strict = false) {
        await act(async () => {
          const element = createElement(DevicesPage, { services, active });
          root.render(strict ? createElement(StrictMode, null, element) : element);
        });
      },
      async close() {
        await act(async () => { root.render(null); });
        await services.dispose();
      },
    };
  }
  try {
    await t.test('无提供者仍保留空态与恢复 GET，POST 空输入后只刷新目录', async () => {
      const context = page();
      try {
        await context.render();
        assert.match(target.textContent ?? '', /还没有可用的设备提供者/);
        assert.ok(target.querySelector('section[aria-label="投屏恢复"]'));
        await settled(() => !button('重试').disabled, '空态没有读取真实恢复视图');
        assert.deepEqual(context.requests.map((item) => item.path), ['/api/v2/plugins/mirroring/recovery']);
        await act(async () => { button('重试').click(); });
        await settled(() => context.requests.some((item) => item.path === '/api/v2/devices'), '恢复后没有刷新目录');
        assert.deepEqual(context.requests.filter((item) => item.method === 'POST').map(({ path, body }) => ({ path, body })), [{
          path: '/api/v2/plugins/mirroring/recovery', body: { generation: 'recovery-g1', input: {} },
        }]);
        assert.deepEqual(context.requests.filter((item) => item.path !== '/api/v2/plugins/mirroring/recovery').map((item) => item.path), [
          '/api/v2/device-providers', '/api/v2/devices',
        ]);
        assert.match(target.textContent ?? '', /还没有可用的设备提供者/);
        assert.equal(context.services.runtime.devices.snapshot().selection, null);
      } finally { await context.close(); }
    });

    await t.test('有提供者但没有选择设备时仍显示全插件入口，不加载投屏工作台', async () => {
      const context = page({ providers: [provider()] });
      try {
        await context.services.runtime.devices.refreshProviders(signal());
        await context.render();
        await settled(() => !button('重试').disabled, '未选设备时恢复入口不可用');
        assert.match(target.textContent ?? '', /还没有发现设备/);
        assert.ok(button('打开设备目录'));
        assert.equal(context.requests.some((item) => item.path === '/api/v2/session-definitions'), false);
        assert.equal(context.requests.some((item) => item.method === 'POST'), false);
      } finally { await context.close(); }
    });

    await t.test('已选、主动取消选择、再选择均只有一个正确作用域入口，空态恢复不重放', async () => {
      const observed = directory('synthetic-provider', 'device-g1', ['synthetic-device']);
      const context = page({ providers: [observed.provider], directories: [observed] });
      const reference = { providerId: 'synthetic-provider', generation: 'device-g1', localId: 'synthetic-device' };
      try {
        await context.services.runtime.devices.refreshDirectories(signal());
        await context.render();
        await settled(() => context.services.runtime.devices.snapshot().selection !== null,
          '父级没有沿原行为选择目录首台设备');
        assert.equal(button('核对并恢复').disabled, false);
        assert.equal(target.querySelectorAll('section[aria-label="投屏恢复"]').length, 1);
        await act(async () => { context.services.runtime.devices.select(null); });
        await settled(() => !button('重试').disabled, '主动取消选择后缺少全插件入口');
        assert.match(target.textContent ?? '', /目录里已有 1 台设备，选一台开始投屏/);
        assert.equal(context.services.runtime.devices.snapshot().selection, null);
        await act(async () => { button('重试').click(); });
        await settled(() => target.textContent?.includes('连接排查') ?? false, '全插件恢复没有完成');
        assert.equal(context.services.runtime.devices.snapshot().selection, null, '恢复不能抢回用户已取消的选择');
        assert.deepEqual(context.requests.filter((item) => item.method === 'POST').map(({ path, body }) => ({ path, body })), [{
          path: '/api/v2/plugins/mirroring/recovery', body: { generation: 'recovery-g1', input: {} },
        }]);
        await act(async () => { context.services.runtime.devices.select(reference); });
        await settled(() => target.querySelectorAll('section[aria-label="投屏恢复"]').length === 1,
          '重新选中设备后恢复入口重复或丢失');
        await act(async () => { button('连接排查').click(); });
        assert.ok(button('核对并恢复'));
        assert.equal(Array.from(target.querySelectorAll('button')).some(
          (item) => item.textContent?.trim() === '核对全部投屏资源'), false);
      } finally { await context.close(); }
    });

    await t.test('inactive 不发 GET，离页取消正在读取的状态，晚到结果不覆盖重入', async () => {
      const context = page({ holdRead: true });
      try {
        await context.render(false);
        assert.equal(context.requests.length, 0);
        await context.render(true);
        const read = context.requests[0];
        assert.ok(read?.signal);
        assert.equal(read.signal.aborted, false);
        await context.render(false);
        assert.equal(read.signal.aborted, true);
        await act(async () => { context.firstRead.resolve(success(recoveryView(true))); });
        assert.equal(context.requests.length, 1);
        assert.doesNotMatch(target.textContent ?? '', /资源核对已通过/);
        await context.render(true);
        await settled(() => !button('重试').disabled, '重入没有重新读取当前恢复状态');
        assert.equal(context.requests.length, 2);
        assert.equal(context.requests.every((item) => item.method === 'GET'), true);
      } finally { await context.close(); }
    });

    for (const leave of ['inactive', 'unmount']) {
      await t.test(`${leave} 取消恢复 POST 等待，晚到成功不刷新目录、不重放设备动作`, async () => {
        const context = page({ holdPost: true });
        try {
          await context.render();
          await settled(() => !button('重试').disabled, '恢复视图未就绪');
          await act(async () => { button('重试').click(); });
          const post = context.requests.find((item) => item.method === 'POST');
          assert.ok(post?.signal);
          assert.equal(post.signal.aborted, false);
          assert.deepEqual(post.body, { generation: 'recovery-g1', input: {} });
          if (leave === 'inactive') await context.render(false);
          else await act(async () => { root.render(null); });
          assert.equal(post.signal.aborted, true);
          const count = context.requests.length;
          await act(async () => { context.post.resolve(success(recoveryView(true))); });
          assert.equal(context.requests.length, count);
          assert.equal(context.requests.every((item) => item.path === '/api/v2/plugins/mirroring/recovery'), true);
          assert.equal(context.requests.filter((item) => item.method === 'POST').length, 1);
        } finally { await context.close(); }
      });
    }

    await t.test('恢复后的目录重查同样在离页时撤销，晚到设备不能被自动选中', async () => {
      const context = page({ providers: [provider()], holdDirectories: true });
      try {
        await context.render();
        await settled(() => !button('重试').disabled, '恢复视图未就绪');
        await act(async () => { button('重试').click(); });
        await settled(() => context.requests.some((item) => item.path === '/api/v2/devices'), '未读取恢复后的目录');
        const read = context.requests.find((item) => item.path === '/api/v2/devices');
        assert.ok(read?.signal);
        assert.equal(read.signal.aborted, false);
        await context.render(false);
        assert.equal(read.signal.aborted, true);
        await act(async () => { context.directories.resolve(success([directory()])); });
        assert.deepEqual(context.services.runtime.devices.snapshot().directories, []);
        assert.equal(context.services.runtime.devices.snapshot().selection, null);
        assert.deepEqual(context.requests.filter((item) => item.method === 'POST').map((item) => item.path), [
          '/api/v2/plugins/mirroring/recovery',
        ]);
      } finally { await context.close(); }
    });

    await t.test('严格模式清理后可再次挂载并恢复，后续目录读取不误用已取消作用域', async () => {
      const context = page();
      try {
        await context.render(true, true);
        await settled(() => !button('重试').disabled, '严格模式重复挂载没有读到恢复状态');
        await act(async () => { button('重试').click(); });
        await settled(() => context.requests.some((item) => item.path === '/api/v2/devices'), '严格模式恢复后没有读取目录');
        const read = context.requests.find((item) => item.path === '/api/v2/devices');
        assert.ok(read?.signal);
        assert.equal(read.signal.aborted, false);
        assert.equal(context.requests.filter((item) => item.method === 'POST').length, 1);
      } finally { await context.close(); }
    });
  } finally {
    await act(async () => { root.unmount(); });
    windowRef.close();
    loader.deregister();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
