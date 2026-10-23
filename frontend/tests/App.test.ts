import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';
import { act, createElement } from 'react';
import type { ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createProductServices } from '../src/app/product/services.ts';
import type { ProductServices } from '../src/app/product/services.ts';
import { dom } from './dom-fixtures.ts';
import { JSDOM } from 'jsdom';
import { requestUrl, success } from './fixtures.ts';
import { directory, provider } from './device-fixtures.ts';

function componentModule(
  value: unknown,
): value is { App: ComponentType<{ services: ProductServices }> } {
  return (
    value !== null && typeof value === 'object' && 'App' in value && typeof value.App === 'function'
  );
}

async function verifyStaticRendering() {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  let requests = 0;
  const services = createProductServices({
    baseUrl: 'http://localhost:7031',
    panelTarget: () => dom(),
    transport: async () => {
      requests += 1;
      throw new Error('静态渲染不应请求服务器');
    },
  });
  try {
    const loaded: unknown = await server.ssrLoadModule('/src/app/product/App.tsx');
    assert.ok(componentModule(loaded), '产品入口应导出 React App 组件');
    const result = renderToStaticMarkup(createElement(loaded.App, { services }));
    for (const label of [
      '设备工坊',
      '设备工作台',
      '性能与调用栈',
      'Frida',
      '自动化',
      '终端',
      'AI 助手',
      '数据分析',
      '任务与日志',
      '市场',
      '设置',
      '工作台',
      '深度调试',
      '扩展创作',
      '工坊',
    ])
      assert.ok(result.includes(label), `缺少入口或页面：${label}`);
    assert.match(result, /还没有可用的设备提供者/);
    assert.match(result, /data-product-workspace/);
    assert.doesNotMatch(result, /开发进度|工作台页面将在后续阶段接入/);
    assert.equal(requests, 0);
  } finally {
    await services.dispose();
    await server.close();
  }
}

// 90s 只覆盖 JSDOM + Vite 模块装载的启动开销（本机单次约 20-30s），不是行为断言放宽。
test('中后台分组导航、折叠与专注保留页面草稿，设备上下文随公开选择更新', { timeout: 90_000 }, async () => {
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
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  const target = windowRef.document.getElementById('test-app');
  assert.ok(target);
  let submissions = 0;
  let desktopClickAvailable = false;
  let deviceAvailable = false;
  const desktopDirectory = directory('desktop', 'g1', ['workstation']);
  const connectedDirectory = {
    ...desktopDirectory,
    devices: desktopDirectory.devices.map((device) => ({ ...device, model: '研发工作站' })),
  };
  const services = createProductServices({
    baseUrl: 'http://localhost:7031',
    panelTarget: () => target,
    transport: async (input, init) => {
      if (init?.method === 'POST' || (input instanceof Request && input.method === 'POST'))
        submissions += 1;
      if (requestUrl(input).pathname.endsWith('/operations'))
        return success([
          {
            id: 'plugin.automation.windows.mouse.position',
            title: '鼠标位置',
            input_schema: { type: 'object' },
          },
          ...(desktopClickAvailable
            ? [
                {
                  id: 'plugin.automation.windows.mouse.click',
                  title: '桌面点击',
                  input_schema: { type: 'object' },
                },
              ]
            : []),
        ]);
      if (requestUrl(input).pathname.endsWith('/device-providers'))
        return success(deviceAvailable ? [provider('desktop')] : []);
      if (requestUrl(input).pathname.endsWith('/devices'))
        return success(deviceAvailable ? [connectedDirectory] : []);
      return success([]);
    },
  });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(target);
  try {
    const loaded: unknown = await server.ssrLoadModule('/src/app/product/App.tsx');
    assert.ok(componentModule(loaded));
    await act(async () => {
      root.render(createElement(loaded.App, { services }));
    });
    const deviceNode = target.querySelector('.workplane > [data-route="devices"]');
    assert.ok(deviceNode);
    const findButton = (label: string) => {
      const button = Array.from(target.querySelectorAll('button')).find(
        (entry) => entry.textContent === label,
      );
      assert.ok(button, `缺少操作：${label}`);
      return button;
    };
    const labeledButton = (label: string) => {
      const button = target.querySelector('button[aria-label="' + label + '"]');
      assert.ok(button instanceof windowRef.HTMLButtonElement, '缺少公开按钮：' + label);
      return button;
    };
    const navigation = () => {
      const node = target.querySelector('nav[aria-label="工坊工具"]');
      assert.ok(node, '左侧导航应有公开可访问名称');
      return node;
    };
    const navigate = (label: string) => {
      const button = Array.from(navigation().querySelectorAll('button')).find(
        (entry) =>
          entry.textContent?.trim() === label || entry.getAttribute('aria-label') === label,
      );
      assert.ok(button, '缺少导航入口：' + label);
      return button;
    };
    const routes = [
      ['devices', '设备'],
      ['performance', '性能与调用栈'],
      ['frida', 'Frida'],
      ['automation', '自动化'],
      ['terminal', '终端'],
      ['ai', 'AI 助手'],
      ['analysis', '数据分析'],
      ['tasks', '任务与日志'],
      ['marketplace', '市场'],
      ['settings', '设置'],
    ];
    const assertCurrent = (routeId: string, label: string) => {
      const current = navigation().querySelectorAll('[aria-current="page"]');
      assert.equal(current.length, 1, '左侧导航只能有一个当前页面');
      assert.equal(current[0], navigate(label));
      const visibleRoutes = Array.from(target.querySelectorAll('.workplane > [data-route]')).filter(
        (entry) => !entry.hasAttribute('hidden'),
      );
      assert.equal(visibleRoutes.length, 1);
      assert.equal(visibleRoutes[0]?.getAttribute('data-route'), routeId);
    };
    // 10 项：「文件与产物」收进设置的二级页；画面与录制、应用与包并入设备页；插件与工具供应并入市场。
    assert.equal(navigation().querySelectorAll('button[data-navigation-route]').length, 10);
    assert.equal(
      Array.from(navigation().querySelectorAll('button[data-navigation-route]')).some(
        (entry) => entry.getAttribute('data-navigation-route') === 'files',
      ),
      false,
      '隐藏路由不应出现在侧栏',
    );
    assert.deepEqual(
      Array.from(navigation().querySelectorAll('h2')).map((heading) => heading.textContent),
      ['工作台', '深度调试', '扩展创作', '工坊'],
    );
    assertCurrent('devices', '设备');
    for (const [routeId, label] of routes) {
      assert.ok(routeId);
      assert.ok(label);
      await act(async () => navigate(label).click());
      assertCurrent(routeId, label);
      assert.equal(windowRef.location.hash, '#' + routeId);
    }
    await act(async () => navigate('设备').click());
    assert.equal(
      target.querySelector('.workplane > [data-route="devices"]'),
      deviceNode,
      '切页不应替换已挂载的设备页面',
    );
    assert.equal(target.querySelector('button[aria-label="选择当前设备"]'), null, '设备目录使用本页设备入口，不重复展示工作设备选择器');
    await act(async () => navigate('性能与调用栈').click());
    const devicePicker = target.querySelector('button[aria-label="选择当前设备"]');
    assert.ok(devicePicker);
    assert.match(devicePicker.textContent ?? '', /尚未选择设备|选择设备/);
    deviceAvailable = true;
    await act(async () => {
      await services.runtime.devices.refreshDirectories(new AbortController().signal);
    });
    await act(async () =>
      services.runtime.devices.select({
        providerId: 'desktop',
        generation: 'g1',
        localId: 'workstation',
      }),
    );
    assert.match(devicePicker.textContent ?? '', /研发工作站/);
    assert.equal(devicePicker.querySelector('.device-context-dot')?.getAttribute('data-state'), 'online');
    await act(async () => navigate('性能与调用栈').click());
    assert.equal(
      target.querySelector('button[aria-label="选择当前设备"]'),
      devicePicker,
      '设备上下文随切页保持',
    );
    assert.match(devicePicker.textContent ?? '', /研发工作站/);
    await act(async () => services.runtime.devices.select(null));
    assert.doesNotMatch(devicePicker.textContent ?? '', /研发工作站/);
    await act(async () => navigate('设备').click());
    assert.equal(target.querySelector('.workplane > [data-route="devices"]'), deviceNode);
    await act(async () => findButton('专注').click());
    assert.ok(target.querySelector('.is-focused'));
    assert.equal(target.querySelector('.workplane > [data-route="devices"]'), deviceNode);
    await act(async () => navigate('设置').click());
    const configuration = target.querySelector('#settings-content');
    assert.ok(configuration instanceof windowRef.HTMLTextAreaElement);
    const setter = Object.getOwnPropertyDescriptor(
      windowRef.HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    assert.ok(setter);
    await act(async () => {
      setter.call(configuration, '{"草稿":"保留"}');
      configuration.dispatchEvent(new windowRef.Event('input', { bubbles: true }));
    });
    await act(async () => navigate('设备').click());
    assert.equal(target.querySelector('.workplane > [data-route="devices"]'), deviceNode);
    assert.equal(target.querySelector('.workplane > [data-route="settings"]')?.hasAttribute('hidden'), true);
    await act(async () => findButton('设置').click());
    assert.equal(target.querySelector('#settings-content'), configuration);
    assert.equal(configuration.value, '{"草稿":"保留"}');
    const shell = target.querySelector('.product-shell');
    assert.ok(shell);
    await act(async () => labeledButton('折叠侧边导航').click());
    assert.equal(shell.getAttribute('data-navigation-collapsed'), 'true');
    assert.equal(target.querySelector('#settings-content'), configuration);
    assert.equal(configuration.value, '{"草稿":"保留"}');
    await act(async () => navigate('设备').click());
    assertCurrent('devices', '设备');
    await act(async () => labeledButton('展开侧边导航').click());
    assert.equal(shell.getAttribute('data-navigation-collapsed'), 'false');
    assert.equal(target.querySelector('.workplane > [data-route="devices"]'), deviceNode);
    await act(async () => navigate('设置').click());
    assert.equal(configuration.value, '{"草稿":"保留"}');
    await act(async () => findButton('退出专注').click());
    assert.equal(target.querySelector('.is-focused'), null);
    const mobileTrigger = labeledButton('打开导航');
    await act(async () => {
      mobileTrigger.focus();
      mobileTrigger.click();
    });
    const mobileDialog = windowRef.document.querySelector('[role="dialog"]');
    assert.ok(mobileDialog);
    assert.match(mobileDialog.textContent ?? '', /工坊导航/);
    assert.equal(mobileDialog.querySelectorAll('button[data-navigation-route]').length, routes.length);
    assert.ok(mobileDialog.contains(windowRef.document.activeElement), '抽屉打开后焦点应进入抽屉');
    await act(async () => {
      mobileDialog.dispatchEvent(
        new windowRef.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(windowRef.document.querySelector('[role="dialog"]'), null);
    assert.equal(windowRef.document.activeElement, mobileTrigger, 'Escape关闭后焦点返回导航触发器');
    await act(async () => mobileTrigger.click());
    const routeDialog = windowRef.document.querySelector('[role="dialog"]');
    assert.ok(routeDialog);
    const mobileSettings = routeDialog.querySelector('button[data-navigation-route="settings"]');
    assert.ok(mobileSettings instanceof windowRef.HTMLButtonElement);
    await act(async () => {
      mobileSettings.click();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(windowRef.document.querySelector('[role="dialog"]'), null);
    assert.equal(
      windowRef.document.activeElement,
      mobileTrigger,
      '抽屉导航后应释放焦点限制并返回触发器',
    );
    assertCurrent('settings', '设置');
    assert.equal(target.querySelector('#settings-content'), configuration);
    assert.equal(configuration.value, '{"草稿":"保留"}');
    await act(async () => navigate('自动化').click());
    assert.equal(findButton('读取服务器鼠标位置').disabled, false);
    for (const label of ['执行桌面点击', '执行桌面连续点击', '开始录制轨迹', '回放输入轨迹'])
      assert.equal(findButton(label).disabled, true, `不能借用鼠标位置能力开放 ${label}`);
    await act(async () => findButton('添加步骤').click());
    assert.match(
      target.querySelector('.workflow-steps')?.textContent ?? '',
      /点击坐标 \(100, 100\)/,
    );
    const remove = target.querySelector('button[aria-label="移除步骤 1"]');
    assert.ok(remove instanceof windowRef.HTMLButtonElement);
    await act(async () => remove.click());
    assert.equal(target.querySelector('.workflow-steps'), null);
    desktopClickAvailable = true;
    await act(async () => {
      await services.runtime.operations.refresh(new AbortController().signal);
    });
    assert.equal(findButton('执行桌面点击').disabled, false);
    await act(async () => findButton('执行桌面点击').click());
    const dialog = windowRef.document.querySelector('[role="dialog"]');
    assert.ok(dialog);
    assert.match(dialog.textContent ?? '', /执行时鼠标当前位置/);
    assert.equal(submissions, 0, '挂载、编辑和打开范围确认框都不得派发桌面输入');
    const returnButton = Array.from(dialog.querySelectorAll('button')).find(
      (button) => button.textContent === '返回修改',
    );
    assert.ok(returnButton);
    await act(async () => returnButton.click());
    assert.equal(windowRef.document.querySelector('[role="dialog"]'), null);
  } finally {
    await act(async () => root.unmount());
    await services.dispose();
    await server.close();
    browser.window.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('React 产品外壳提供真实工具导航与设备空态，不在静态渲染时发起请求', verifyStaticRendering);
