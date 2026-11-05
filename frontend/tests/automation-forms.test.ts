import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import type { Dispose, HostContext } from '../src/plugin-sdk/index.ts';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';

const page = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://127.0.0.1:7031/#/automation', pretendToBeVisual: true,
});
const document = page.window.document;
const previous = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: page.window, document, navigator: page.window.navigator,
  Element: page.window.Element, HTMLElement: page.window.HTMLElement, Node: page.window.Node,
  HTMLInputElement: page.window.HTMLInputElement, HTMLButtonElement: page.window.HTMLButtonElement,
  HTMLFormElement: page.window.HTMLFormElement, HTMLSelectElement: page.window.HTMLSelectElement,
  DocumentFragment: page.window.DocumentFragment, NodeFilter: page.window.NodeFilter,
  MutationObserver: page.window.MutationObserver, CustomEvent: page.window.CustomEvent,
  getComputedStyle: page.window.getComputedStyle.bind(page.window),
  requestAnimationFrame: page.window.requestAnimationFrame.bind(page.window),
  cancelAnimationFrame: page.window.cancelAnimationFrame.bind(page.window), IS_REACT_ACT_ENVIRONMENT: true,
})) {
  previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
// 只跳过JSDOM不实现的滚动，不用它推导真实几何或视觉结果。
Object.defineProperty(page.window.HTMLElement.prototype, 'scrollIntoView', { configurable: true, value() {} });
const imports = registerCompositionStartupImports();
const { installPublicUi } = await import('../src/app/public-ui.ts');
const { hostUi } = await import('../src/plugin-sdk/index.ts');
const releaseUi = installPublicUi();
const { AutomationPage } = await import('../plugins/automation/src/view.tsx');
const { createAutomationServices } = await import('../plugins/automation/src/services.ts');
after(async () => {
  await act(async () => {});
  await new Promise<void>((resolve) => setImmediate(resolve));
  await releaseUi(); imports.dispose(); page.window.close();
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  }
});

function button(root: ParentNode, text: string) {
  const found = [...root.querySelectorAll<HTMLButtonElement>('button')].find((element) =>
    (element.getAttribute('aria-label') ?? element.textContent?.trim()) === text);
  assert.ok(found, `缺少自动化操作：${text}`); return found;
}
function control(root: ParentNode, text: string) {
  const label = [...root.querySelectorAll('label')].find((element) => element.textContent?.trim() === text);
  assert.ok(label, `缺少自动化标签：${text}`);
  const found = document.getElementById(label.htmlFor);
  assert.ok(found && root.contains(found), `标签必须指向当前自动化实例：${text}`);
  return { label, element: found };
}
async function fixture() {
  const owner = new AbortController();
  let submissions = 0, directoryReads = 0;
  const unavailable = async (): Promise<never> => { submissions++; throw new Error('表单单元禁止派发设备、桌面或录制动作'); };
  const context: HostContext = {
    apiVersion: 2, signal: owner.signal, submit: unavailable, getJob: unavailable, cancelJob: unavailable,
    listOperations: async () => { directoryReads++; return { data: [], logId: null }; },
    subscribeOperations: () => () => {}, onDispose: (release) => release, onCleanup: () => () => {},
    artifacts: { upload: unavailable, download: unavailable },
    devices: {
      snapshot: () => ({ providers: [], directories: [], selection: null, selected: null }),
      subscribe: () => () => {}, select: () => {}, refreshProviders: unavailable,
      refreshDirectories: unavailable, refreshProvider: unavailable, invoke: unavailable,
    },
  };
  const firstServices = createAutomationServices(context), secondServices = createAutomationServices(context);
  const root = document.createElement('main'); document.body.append(root);
  let release: Dispose = () => {};
  try {
    await act(async () => {
      release = hostUi().mountReact(root, createElement('div', null,
        createElement(AutomationPage, { services: firstServices }),
        createElement(AutomationPage, { services: secondServices })));
    });
  } catch (error) {
    try { await act(async () => { await release(); }); }
    finally { owner.abort(); firstServices.dispose(); secondServices.dispose(); root.remove(); }
    throw error;
  }
  const instances = [...root.querySelectorAll<HTMLElement>('[data-product-page="automation"]')];
  const first = instances[0], second = instances[1]; assert.ok(first && second);
  return {
    first, second, submissions: () => submissions, reads: () => directoryReads,
    async dispose() {
      try { await act(async () => { await release(); }); }
      finally { owner.abort(); firstServices.dispose(); secondServices.dispose(); root.remove(); }
    },
  };
}

test('自动化多实例标签只控制本实例的桌面开关、模式及录制选择', async () => {
  const f = await fixture();
  try {
    for (const root of [f.first, f.second]) {
      for (const label of root.querySelectorAll<HTMLLabelElement>('label[for]'))
        assert.ok(root.contains(document.getElementById(label.htmlFor)), '所有标签包括F9开关都必须属于本实例');
      for (const text of ['使用指定坐标', '鼠标按键', '点击类型', '停止方式']) control(root, text);
      const traceLabel = [...root.querySelectorAll('label')].find((entry) => entry.htmlFor &&
        root.querySelector(`[id="${entry.htmlFor}"]`)?.getAttribute('aria-label') === '轨迹事件类型');
      assert.ok(traceLabel);
      assert.ok(root.contains(document.getElementById(traceLabel.htmlFor)), '录制标签必须属于本实例');
    }
    const first = control(f.first, '使用指定坐标'), second = control(f.second, '使用指定坐标');
    const reads = f.reads();
    await act(async () => { button(f.second, '桌面操作').click(); second.label.click(); });
    assert.equal(first.element.getAttribute('aria-checked'), 'false');
    assert.equal(second.element.getAttribute('aria-checked'), 'true');
    const firstX = control(f.first, '桌面 X 坐标').element, secondX = control(f.second, '桌面 X 坐标').element;
    assert.ok(firstX instanceof page.window.HTMLInputElement && secondX instanceof page.window.HTMLInputElement);
    assert.equal(firstX.disabled, true); assert.equal(secondX.disabled, false);
    assert.equal(f.reads(), reads); assert.equal(f.submissions(), 0);
  } finally { await f.dispose(); }
});

test('自动化步骤表单切换页签保留文本草稿，添加本地步骤不派发真实输入', async () => {
  const f = await fixture();
  try {
    await act(async () => { button(f.first, '添加第一个步骤').click(); });
    await act(async () => { button(f.first.querySelector('[aria-label="添加步骤表单"]') ?? f.first, '文本').click(); });
    const text = control(f.first, '设备输入文本').element;
    assert.ok(text instanceof page.window.HTMLInputElement);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(page.window.HTMLInputElement.prototype, 'value')?.set;
      assert.ok(setter); setter.call(text, 'hello-agent');
      text.dispatchEvent(new page.window.Event('input', { bubbles: true }));
    });
    await act(async () => { button(f.first, '桌面操作').click(); });
    await act(async () => { button(f.first, '设备步骤').click(); });
    assert.ok(control(f.first, '设备输入文本').element === text, '页签往返保留原输入DOM');
    assert.equal(text.value, 'hello-agent');
    const reads = f.reads();
    await act(async () => { button(f.first, '添加到流程').click(); });
    const items = f.first.querySelectorAll('[aria-label="设备流程步骤"] > li');
    assert.equal(items.length, 1); assert.match(items[0]?.textContent ?? '', /hello-agent/);
    assert.equal(f.second.querySelector('[aria-label="设备流程步骤"]'), null);
    assert.equal(f.reads(), reads); assert.equal(f.submissions(), 0);
  } finally { await f.dispose(); }
});
