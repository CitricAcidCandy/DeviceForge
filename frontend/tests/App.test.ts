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

function componentModule(value: unknown): value is { App: ComponentType<{ services: ProductServices }> } {
  return value !== null && typeof value === 'object' && 'App' in value && typeof value.App === 'function';
}

async function verifyStaticRendering() {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  let requests = 0;
  const services = createProductServices({ baseUrl: 'http://localhost:7031', panelTarget: () => dom(), transport: async () => { requests += 1; throw new Error('静态渲染不应请求服务器'); } });
  try {
    const loaded: unknown = await server.ssrLoadModule('/src/app/product/App.tsx');
    assert.ok(componentModule(loaded), '产品入口应导出 React App 组件');
    const result = renderToStaticMarkup(createElement(loaded.App, { services }));
    for (const label of ['设备工坊', '设备工作台', '应用与包', '文件与产物', '性能与调用栈', 'Frida', '自动化', '终端', 'AI 助手', '数据分析', '插件', '任务与日志', '设置', '全部工具']) assert.ok(result.includes(label), `缺少入口或页面：${label}`);
    assert.match(result, /还没有可用的设备提供者/);
    assert.match(result, /data-product-workspace/);
    assert.doesNotMatch(result, /开发进度|工作台页面将在后续阶段接入/);
    assert.equal(requests, 0);
  } finally {
    await services.dispose();
    await server.close();
  }
}

test('真实 DOM 导航与专注切换保留页面节点和配置草稿，卸载释放应用', async () => {
  const browser = new JSDOM('<!doctype html><html><body><div id="test-app"></div></body></html>', { url: 'http://localhost:7031' });
  const windowRef = browser.window;
  Object.defineProperty(windowRef, 'matchMedia', { configurable: true, value: (media: string): MediaQueryList => ({ matches: false, media, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } }) });
  const globals: Readonly<Record<string, unknown>> = { window: windowRef, document: windowRef.document, navigator: windowRef.navigator, Element: windowRef.Element, DocumentFragment: windowRef.DocumentFragment, HTMLElement: windowRef.HTMLElement, HTMLFormElement: windowRef.HTMLFormElement, HTMLInputElement: windowRef.HTMLInputElement, HTMLSelectElement: windowRef.HTMLSelectElement, HTMLTextAreaElement: windowRef.HTMLTextAreaElement, Node: windowRef.Node, NodeFilter: windowRef.NodeFilter, MutationObserver: windowRef.MutationObserver, Event: windowRef.Event, CustomEvent: windowRef.CustomEvent, getComputedStyle: windowRef.getComputedStyle.bind(windowRef), IS_REACT_ACT_ENVIRONMENT: true };
  const descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  const target = windowRef.document.getElementById('test-app');
  assert.ok(target);
  let submissions = 0;
  let desktopClickAvailable = false;
  const services = createProductServices({ baseUrl: 'http://localhost:7031', panelTarget: () => target, transport: async (input, init) => {
    if (init?.method === 'POST' || input instanceof Request && input.method === 'POST') submissions += 1;
    if (requestUrl(input).pathname.endsWith('/operations')) return success([
      {id: 'plugin.automation.windows.mouse.position', title: '鼠标位置', input_schema: {type: 'object'}},
      ...(desktopClickAvailable ? [{id: 'plugin.automation.windows.mouse.click', title: '桌面点击', input_schema: {type: 'object'}}] : []),
    ]);
    return success([]);
  } });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(target);
  try {
    const loaded: unknown = await server.ssrLoadModule('/src/app/product/App.tsx');
    assert.ok(componentModule(loaded));
    await act(async () => { root.render(createElement(loaded.App, { services })); });
    const deviceNode = target.querySelector('[data-route="devices"]');
    assert.ok(deviceNode);
    const findButton = (label: string) => {
      const button = Array.from(target.querySelectorAll('button')).find((entry) => entry.textContent === label);
      assert.ok(button, `缺少操作：${label}`); return button;
    };
    await act(async () => findButton('专注').click());
    assert.ok(target.querySelector('.is-focused'));
    assert.equal(target.querySelector('[data-route="devices"]'), deviceNode);
    await act(async () => findButton('设置').click());
    const configuration = target.querySelector('#settings-content');
    assert.ok(configuration instanceof windowRef.HTMLTextAreaElement);
    const setter = Object.getOwnPropertyDescriptor(windowRef.HTMLTextAreaElement.prototype, 'value')?.set;
    assert.ok(setter);
    await act(async () => { setter.call(configuration, '{"草稿":"保留"}'); configuration.dispatchEvent(new windowRef.Event('input', { bubbles: true })); });
    await act(async () => findButton('设备').click());
    assert.equal(target.querySelector('[data-route="devices"]'), deviceNode);
    assert.equal(target.querySelector('[data-route="settings"]')?.hasAttribute('hidden'), true);
    await act(async () => findButton('设置').click());
    assert.equal(target.querySelector('#settings-content'), configuration);
    assert.equal(configuration.value, '{"草稿":"保留"}');
    await act(async () => findButton('退出专注').click());
    assert.equal(target.querySelector('.is-focused'), null);
    await act(async () => findButton('自动化').click());
    assert.equal(findButton('读取服务器鼠标位置').disabled, false);
    for (const label of ['执行桌面点击', '执行桌面连续点击', '开始录制轨迹', '回放输入轨迹']) assert.equal(findButton(label).disabled, true, `不能借用鼠标位置能力开放 ${label}`);
    await act(async () => findButton('添加步骤').click());
    assert.match(target.querySelector('.workflow-steps')?.textContent ?? '', /点击坐标 \(100, 100\)/);
    const remove = target.querySelector('button[aria-label="移除步骤 1"]');
    assert.ok(remove instanceof windowRef.HTMLButtonElement);
    await act(async () => remove.click());
    assert.equal(target.querySelector('.workflow-steps'), null);
    desktopClickAvailable = true;
    await act(async () => { await services.runtime.operations.refresh(new AbortController().signal); });
    assert.equal(findButton('执行桌面点击').disabled, false);
    await act(async () => findButton('执行桌面点击').click());
    const dialog = windowRef.document.querySelector('[role="dialog"]');
    assert.ok(dialog);
    assert.match(dialog.textContent ?? '', /执行时鼠标当前位置/);
    assert.equal(submissions, 0, '挂载、编辑和打开范围确认框都不得派发桌面输入');
    const returnButton = Array.from(dialog.querySelectorAll('button')).find(button => button.textContent === '返回修改');
    assert.ok(returnButton);
    await act(async () => returnButton.click());
    assert.equal(windowRef.document.querySelector('[role="dialog"]'), null);
  } finally {
    await act(async () => root.unmount());
    await services.dispose();
    await server.close();
    browser.window.close();
    for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});

test('React 产品外壳提供真实工具导航与设备空态，不在静态渲染时发起请求', verifyStaticRendering);

