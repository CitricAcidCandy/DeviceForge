import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import type { ComponentType } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import { createProductServices } from '../src/app/product/services.ts';
import type { ProductServices } from '../src/app/product/services.ts';
import type { DeviceProviderInfo } from '../src/plugin-sdk/index.ts';
import { directory, provider } from './device-fixtures.ts';
import { job, requestUrl, signal, success } from './fixtures.ts';

function pageModule(value: unknown): value is {
  DevicesPage: ComponentType<{ services: ProductServices; active: boolean }>;
} {
  return typeof value === 'object' && value !== null &&
    'DevicesPage' in value && typeof value.DevicesPage === 'function';
}

function connectModule(value: unknown): value is {
  DevicesConnect: ComponentType<{ services: ProductServices; initialProvider: DeviceProviderInfo }>;
} {
  return typeof value === 'object' && value !== null &&
    'DevicesConnect' in value && typeof value.DevicesConnect === 'function';
}

async function settled(condition: () => boolean, message: string) {
  for (let attempt = 0; attempt < 100 && !condition(); attempt++)
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
  assert.ok(condition(), message);
}

async function withPage(
  transport: typeof fetch,
  run: (context: {
    services: ProductServices;
    target: HTMLElement;
    windowRef: JSDOM['window'];
    renderPage(): Promise<void>;
    renderConnect(): Promise<void>;
  }) => Promise<void>,
) {
  const browser = new JSDOM('<div id="discovery-feedback"></div>', {
    pretendToBeVisual: true,
    url: 'http://localhost:7031',
  });
  const windowRef = browser.window;
  const globals: Readonly<Record<string, unknown>> = {
    window: windowRef, document: windowRef.document, navigator: windowRef.navigator,
    HTMLElement: windowRef.HTMLElement, Element: windowRef.Element, Node: windowRef.Node,
    HTMLFormElement: windowRef.HTMLFormElement, HTMLInputElement: windowRef.HTMLInputElement,
    HTMLSelectElement: windowRef.HTMLSelectElement,
    Event: windowRef.Event, CustomEvent: windowRef.CustomEvent,
    DocumentFragment: windowRef.DocumentFragment, MutationObserver: windowRef.MutationObserver,
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
  // 先建立DOM再初始化ReactDOM，让受控地址输入沿真实change事件路径更新。
  const { createRoot } = await import('react-dom/client');
  const services = createProductServices({
    baseUrl: 'http://localhost:7031', transport, panelTarget: () => null,
  });
  const server = await createServer({
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
    plugins: [{
      name: 'device-discovery-feedback-screen',
      enforce: 'pre',
      resolveId(id, importer) {
        if (id === './screen/index.tsx' && importer?.replaceAll('\\', '/').endsWith('/pages/devices/index.tsx'))
          return '\0device-discovery-feedback-screen';
      },
      load(id) {
        if (id === '\0device-discovery-feedback-screen')
          return 'export function DeviceScreen() { return null; }';
      },
    }],
  });
  const target = windowRef.document.getElementById('discovery-feedback');
  assert.ok(target);
  const root = createRoot(target);
  try {
    await run({
      services, target, windowRef,
      async renderPage() {
        const loaded: unknown = await server.ssrLoadModule('/src/pages/devices/index.tsx');
        assert.ok(pageModule(loaded));
        await act(async () => root.render(createElement(loaded.DevicesPage, { services, active: true })));
      },
      async renderConnect() {
        const loaded: unknown = await server.ssrLoadModule('/src/pages/devices/components/DevicesConnect/index.tsx');
        assert.ok(connectModule(loaded));
        const initialProvider = services.runtime.devices.snapshot().providers[0];
        assert.ok(initialProvider);
        await act(async () => root.render(createElement(loaded.DevicesConnect, { services, initialProvider })));
      },
    });
  } finally {
    await act(async () => root.unmount());
    await services.dispose();
    await server.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    browser.window.close();
  }
}

function button(target: HTMLElement, label: string) {
  const result = Array.from(target.querySelectorAll('button')).find(
    (item) => (item.getAttribute('aria-label') ?? item.textContent?.trim()) === label,
  );
  assert.ok(result, `缺少设备操作：${label}`);
  return result;
}

const discoveryFailure = (logId: string, message: string) =>
  Response.json(
    { log_id: logId, error: { code: 'discovery_failed', message } },
    { status: 502, headers: { 'x-deviceforge-log-id': logId } },
  );

for (const partial of [false, true]) {
  test(`${partial ? '部分' : '全部'}设备发现失败通知显示具体提供者原因与失败ID`, async () => {
    await withPage(async (input) => {
      const path = requestUrl(input).pathname;
      if (path.endsWith('/device-providers'))
        return success([provider('android'), provider('harmony')], 'providers-success-log');
      if (path.endsWith('/devices')) return success([], 'directories-success-log');
      if (path.includes('/android/'))
        return discoveryFailure('android-failure-log', '插件资源清理未确认');
      if (path.includes('/harmony/'))
        return partial
          ? success(directory('harmony'), 'harmony-success-log')
          : discoveryFailure('harmony-failure-log', 'HDC发现输出含非法控制符');
      throw new Error(`未预期请求：${path}`);
    }, async ({ services, target, renderPage }) => {
      await services.runtime.devices.refreshProviders(signal());
      await renderPage();
      await act(async () => button(target, '设备目录').click());
      await act(async () => button(target, '发现设备').click());
      await settled(
        () => services.messages.snapshot().some((item) => item.level === 'warning'),
        '没有显示发现失败通知',
      );
      const notice = services.messages.snapshot().find((item) => item.level === 'warning');
      assert.ok(notice);
      assert.equal(notice.title, partial ? '部分设备提供者发现失败' : '设备发现未完成');
      assert.equal(notice.logId, 'android-failure-log');
      assert.ok(notice.description?.includes('android：插件资源清理未确认'));
      assert.deepEqual(notice.details?.map((item) => [item.label, item.logId]), partial
        ? [['android', 'android-failure-log']]
        : [['android', 'android-failure-log'], ['harmony', 'harmony-failure-log']]);
      if (!partial) assert.ok(notice.description?.includes('harmony：HDC发现输出含非法控制符'));
      await act(async () => button(target, '读取目录').click());
      const retained = services.messages.snapshot().find((item) => item.id === notice.id);
      assert.equal(retained?.logId, 'android-failure-log', '后续成功读取不能改写原失败通知');
    });
  });
}

for (const discoveryLogId of ['discovery-failure-log', null]) {
  test(`连接已完成但发现失败${discoveryLogId ? '保留失败ID' : '不借用成功任务ID'}`, async () => {
    const targetProvider = provider();
    const declaration = {
      ...targetProvider,
      definition: {
        ...targetProvider.definition,
        capabilities: [{
          id: 'connect', version: 1, operation: 'example.connect',
          scope: 'provider', access: 'write',
        }],
      },
    };
    await withPage(async (input) => {
      const path = requestUrl(input).pathname;
      if (path.endsWith('/device-providers'))
        return success([declaration], 'providers-success-log');
      if (path.endsWith('/operations'))
        return success([{
          id: 'example.connect', title: '连接地址',
          input_schema: {
            type: 'object',
            properties: {
              input: {
                type: 'object', properties: { address: { type: 'string' } },
                required: ['address'],
              },
            },
          },
        }]);
      if (path.endsWith('/device-actions'))
        return success({ ...job('connection-job'), operation: 'example.connect' }, 'submit-success-log');
      if (path.endsWith('/jobs/connection-job'))
        return success({
          ...job('connection-job'), operation: 'example.connect', status: 'succeeded',
          result: { result: { output: 'connected' }, artifacts: [] }, error: null,
        }, 'task-success-log');
      if (path.endsWith('/example/refresh')) {
        if (!discoveryLogId) throw new Error('受控网络中断');
        return discoveryFailure(discoveryLogId, '插件资源清理未确认');
      }
      throw new Error(`未预期请求：${path}`);
    }, async ({ services, target, windowRef, renderConnect }) => {
      await services.runtime.devices.refreshProviders(signal());
      await services.runtime.operations.refresh(signal());
      await renderConnect();
      const input = target.querySelector('input');
      assert.ok(input instanceof windowRef.HTMLInputElement);
      const setter = Object.getOwnPropertyDescriptor(windowRef.HTMLInputElement.prototype, 'value')?.set;
      assert.ok(setter);
      await act(async () => {
        setter.call(input, '127.0.0.1:5555');
        input.dispatchEvent(new windowRef.Event('input', { bubbles: true }));
      });
      assert.equal(button(target, '连接地址').disabled, false);
      await act(async () => button(target, '连接地址').click());
      await settled(
        () => services.messages.snapshot().some((item) => item.level === 'warning'),
        '没有显示连接后发现失败通知',
      );
      const notice = services.messages.snapshot().find((item) => item.level === 'warning');
      assert.ok(notice);
      assert.equal(notice.title, '连接已完成，设备目录未更新');
      assert.equal(notice.logId, discoveryLogId);
      assert.ok(notice.description?.includes(
        discoveryLogId ? 'example：插件资源清理未确认' : 'example：无法取得服务器响应',
      ));
      assert.deepEqual(notice.details?.map((item) => [item.label, item.logId]), [
        ['设备发现', discoveryLogId],
        ['设备任务', 'task-success-log'],
      ]);
      assert.equal(services.messages.snapshot().some((item) => item.level === 'success'), false);
    });
  });
}
