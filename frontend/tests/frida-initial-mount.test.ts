import assert from 'node:assert/strict';
import test from 'node:test';
import { act } from 'react';
import { JSDOM } from 'jsdom';
import type { Dispose } from '../src/plugin-sdk/index.ts';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';
import { requestUrl } from './fixtures.ts';

/** 测试自身有界等待；未完成的目录响应没有定时器，也不模拟成功结果。 */
async function within<T>(pending: Promise<T>, limitMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new Error(message)); }, limitMs);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

test('Frida首次公开挂载不等待永不完成的操作目录，空设备界面可用且释放撤销监听',
  { timeout: 12_000 }, async (unit) => {
    const parser = registerCompositionStartupImports();
    const browser = new JSDOM('<!doctype html><html><body><main id="frida-root"></main></body></html>', {
      url: 'http://frida-initial-mount.invalid/', pretendToBeVisual: true,
    });
    const saved = new Map<string, PropertyDescriptor | undefined>();
    for (const [name, value] of Object.entries({
      window: browser.window, document: browser.window.document, navigator: browser.window.navigator,
      HTMLElement: browser.window.HTMLElement, Element: browser.window.Element, Node: browser.window.Node,
      NodeFilter: browser.window.NodeFilter, DocumentFragment: browser.window.DocumentFragment,
      HTMLInputElement: browser.window.HTMLInputElement, HTMLSelectElement: browser.window.HTMLSelectElement,
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
    let directFetch = 0;
    unit.mock.method(globalThis, 'fetch', async () => {
      directFetch++; throw new Error('Frida首次挂载单元禁止真实网络');
    });
    const resources: Dispose[] = [];
    const caller = new AbortController();
    unit.after(async () => {
      caller.abort();
      try { for (const dispose of resources.reverse()) await act(async () => { await dispose(); }); }
      finally {
        await new Promise<void>((resolve) => setImmediate(resolve));
        parser.dispose(); browser.window.close();
        for (const [name, descriptor] of saved) {
          if (descriptor) Object.defineProperty(globalThis, name, descriptor);
          else Reflect.deleteProperty(globalThis, name);
        }
      }
    });
    assert.deepEqual(parser.diagnostics, []);
    const { installPublicUi } = await import('../src/app/public-ui.ts');
    resources.push(installPublicUi());
    const { createFrontendRuntime } = await import('../src/app/runtime.ts');
    const { default: createFridaPlugin } = await import('../plugins/frida/src/index.ts');
    const requests: string[] = [], operationSignals: AbortSignal[] = [];
    const forever = new Promise<Response>(() => {});
    const runtime = createFrontendRuntime({
      baseUrl: 'http://frida-initial-mount.invalid', workspaceStorage: null, panelTarget: () => null,
      transport: async (input, init) => {
        const path = requestUrl(input).pathname, method = init?.method ?? 'GET';
        requests.push(`${method} ${path}`);
        if (method === 'GET' && path === '/api/v2/operations') {
          const signal = init?.signal;
          assert.ok(signal, '真实目录请求必须携带所属取消信号');
          operationSignals.push(signal);
          return forever;
        }
        throw new Error(`Frida首次挂载不得派发其他请求：${method} ${path}`);
      },
    });
    resources.push(runtime.dispose);
    const subscriptions = { operations: 0, devices: 0 };
    const subscribeOperations = runtime.operations.subscribe;
    unit.mock.method(runtime.operations, 'subscribe',
      (listener: Parameters<typeof subscribeOperations>[0]) => {
        subscriptions.operations++;
        const release = subscribeOperations(listener);
        let active = true;
        return () => {
          if (!active) return;
          active = false; subscriptions.operations--; return release();
        };
      });
    const subscribeDevices = runtime.devices.subscribe;
    unit.mock.method(runtime.devices, 'subscribe',
      (listener: Parameters<typeof subscribeDevices>[0]) => {
        subscriptions.devices++;
        const release = subscribeDevices(listener);
        let active = true;
        return () => {
          if (!active) return;
          active = false; subscriptions.devices--; return release();
        };
      });
    const pluginId = 'frida_initial_unit';
    runtime.bundledPlugins.register({ id: pluginId, trusted: true,
      plugin: createFridaPlugin({ id: pluginId, version: '1', apiVersion: 2 }) });
    await within(runtime.webPlugins.load(pluginId), 3_000, '插件登记不能等待操作目录');
    const ui = runtime.host.ui;
    assert.ok(ui?.mount);
    assert.ok(runtime.host.devices && runtime.host.artifacts, '真实公开宿主必须提供设备及产物能力');
    assert.deepEqual(runtime.host.devices.snapshot().providers, []);
    assert.equal(runtime.host.devices.snapshot().selection, null);
    const instanceId = 'host.frida_initial_mount';
    ui.open({ instanceId, workspaceId: `${pluginId}.workspace`,
      provider: { pluginId, viewId: `${pluginId}.main` } }, caller.signal);
    const root = browser.window.document.getElementById('frida-root'); assert.ok(root);
    const pending = ui.mount(instanceId, root, caller.signal);
    let release: Dispose = () => {};
    await act(async () => {
      release = await within(pending, 3_000, '操作目录永不完成时，首次公开挂载仍须有界返回');
    });
    resources.push(release);
    assert.equal(root.querySelector('h1')?.textContent, 'Frida');
    const scriptLabel = [...root.querySelectorAll('label')]
      .find((label) => label.textContent === 'UTF-8 脚本');
    assert.ok(scriptLabel?.htmlFor);
    const script = browser.window.document.getElementById(scriptLabel.htmlFor);
    assert.ok(script instanceof browser.window.HTMLInputElement && script.type === 'file');
    assert.equal(script.closest('[hidden]'), null);
    assert.match(root.textContent ?? '', /请选择支持 Frida 的在线设备/);
    assert.match(root.textContent ?? '', /尚无执行结果/);
    assert.deepEqual(requests, ['GET /api/v2/operations']);
    assert.equal(operationSignals.length, 1, '目录只发起一次等待，不靠自动重试换取首帧');
    assert.equal(operationSignals[0]?.aborted, false);
    assert.equal(subscriptions.operations, 1);
    assert.equal(subscriptions.devices, 1);
    await act(async () => { await release(); });
    assert.equal(root.childElementCount, 0);
    assert.deepEqual(subscriptions, { operations: 0, devices: 0 });
    assert.equal(operationSignals[0]?.aborted, true, '释放所属界面必须终止目录等待');
    assert.deepEqual(requests, ['GET /api/v2/operations']);
    assert.equal(directFetch, 0);
    unit.diagnostic('目录响应始终未完成；3秒测试时限内公开挂载返回。仅内存DOM/transport，不代表实际浏览器视觉或冷启动性能。');
  });
