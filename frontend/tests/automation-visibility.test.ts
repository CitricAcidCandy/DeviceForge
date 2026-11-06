import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { act } from 'react';
import { JSDOM } from 'jsdom';
import type { Dispose } from '../src/plugin-sdk/index.ts';
import { createFrontendRuntime } from '../src/app/runtime.ts';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';

async function fixture(unit: TestContext) {
  const parser = registerCompositionStartupImports();
  assert.deepEqual(parser.diagnostics, []);
  const browser = new JSDOM('<!doctype html><html><body><main></main><aside></aside></body></html>', {
    url: 'http://127.0.0.1:7031/#/automation', pretendToBeVisual: true,
  });
  const w = browser.window, document = w.document;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: w, document, navigator: w.navigator, Element: w.Element, HTMLElement: w.HTMLElement,
    Node: w.Node, NodeFilter: w.NodeFilter, DocumentFragment: w.DocumentFragment,
    HTMLInputElement: w.HTMLInputElement, HTMLButtonElement: w.HTMLButtonElement,
    HTMLFormElement: w.HTMLFormElement, HTMLSelectElement: w.HTMLSelectElement,
    CustomEvent: w.CustomEvent, Event: w.Event, KeyboardEvent: w.KeyboardEvent,
    FocusEvent: w.FocusEvent, MutationObserver: w.MutationObserver,
    getComputedStyle: w.getComputedStyle.bind(w),
    requestAnimationFrame: w.requestAnimationFrame.bind(w), cancelAnimationFrame: w.cancelAnimationFrame.bind(w),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  w.HTMLElement.prototype.scrollIntoView = () => {};
  let network = 0, unexpected = 0, reads = 0;
  unit.mock.method(globalThis, 'fetch', async () => { network++; throw new Error('自动化确认单元禁止真实网络'); });
  const { installPublicUi } = await import('../src/app/public-ui.ts');
  const removeUi = installPublicUi();
  const { default: createAutomationPlugin } = await import('../plugins/automation/src/index.ts');
  const runtime = createFrontendRuntime({
    baseUrl: 'http://127.0.0.1:7031', workspaceStorage: null, panelTarget: () => null,
    transport: async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname !== '/api/v2/operations') {
        unexpected++; throw new Error('确认前不得提交、读取任务或调用设备能力');
      }
      reads++;
      return Response.json({ log_id: 'memory-automation-operations', data: [
        'windows.mouse.click', 'windows.mouse.repeat', 'input_trace.record', 'input_trace.playback',
      ].map((action) => ({ id: `plugin.automation.${action}`, title: action, input_schema: { type: 'object' } })) });
    },
  });
  const id = 'visibility_automation';
  runtime.bundledPlugins.register({ id, trusted: true,
    plugin: createAutomationPlugin({ id, version: '1', apiVersion: 2 }) });
  await runtime.webPlugins.load(id);
  const ui = runtime.host.ui; assert.ok(ui?.mount);
  const activeUi = ui;
  const first = document.querySelector('main'), second = document.querySelector('aside');
  assert.ok(first && second);
  const mounted: Dispose[] = [];
  async function mount(instanceId: string, target: HTMLElement) {
    let release: Dispose = () => {};
    await act(async () => { assert.ok(activeUi.mount); release = await activeUi.mount(instanceId, target, new AbortController().signal); });
    mounted.push(release); return release;
  }
  unit.after(async () => {
    try {
      await act(async () => { for (const release of mounted.reverse()) await release(); });
      await runtime.dispose();
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      await removeUi(); parser.dispose(); browser.window.close();
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });
  const instanceId = `${id}.main.default`;
  return {
    browser, document, first, second, ui, mount, instanceId,
    reads: () => reads, network: () => network, unexpected: () => unexpected,
    async visible(visible: boolean) { await act(async () => { ui.setVisible(instanceId, visible); }); },
    async secondInstance() {
      const next = 'host.automation.second';
      ui.open({ instanceId: next, workspaceId: `${id}.workspace`,
        provider: { pluginId: id, viewId: `${id}.main` } }, new AbortController().signal);
      return mount(next, second);
    },
  };
}

function button(root: ParentNode, label: string) {
  const found = [...root.querySelectorAll<HTMLButtonElement>('button')]
    .find((element) => (element.getAttribute('aria-label') ?? element.textContent?.trim()) === label);
  assert.ok(found, `缺少原自动化入口：${label}`); return found;
}
function field(root: ParentNode, label: string) {
  const found = [...root.querySelectorAll<HTMLLabelElement>('label')]
    .find((element) => element.textContent?.trim() === label);
  assert.ok(found);
  const input = found.ownerDocument.getElementById(found.htmlFor);
  const w = found.ownerDocument.defaultView; assert.ok(w);
  assert.ok(input instanceof w.HTMLInputElement && root.contains(input));
  return input;
}
async function type(input: HTMLInputElement, value: string) {
  const w = input.ownerDocument.defaultView; assert.ok(w);
  const setter = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value')?.set; assert.ok(setter);
  await act(async () => { setter.call(input, value); input.dispatchEvent(new w.Event('input', { bubbles: true })); });
}
async function click(root: ParentNode, label: string) {
  const target = button(root, label);
  await act(async () => { target.focus(); target.click(); });
  return target;
}
function dialog(document: Document) {
  const result = document.querySelector<HTMLElement>('[role="dialog"]'); assert.ok(result); return result;
}
function shell(root: ParentNode) {
  const result = root.querySelector('[data-product-page="automation"]')?.parentElement;
  assert.ok(result); return result;
}

test('自动化确认可见性：切页签关闭桌面及轨迹确认，隐藏页面保草稿且不夺另一实例焦点', async (unit) => {
  const f = await fixture(unit);
  await f.mount(f.instanceId, f.first);
  await click(f.first, '桌面操作');
  const interval = field(f.first, '点击间隔（ms）');
  await type(interval, '765');
  const clickTrigger = await click(f.first, '执行一次点击');
  const desktop = dialog(f.document);
  assert.match(desktop.textContent ?? '', /在服务器桌面点击/u);
  await click(f.first, '输入录制与回放');
  assert.equal(desktop.isConnected, false, '切离桌面页签必须撤销所属执行确认');
  const artifact = field(f.first, '回放轨迹产物 ID');
  await type(artifact, 'memory-trace-artifact');
  const recordTrigger = await click(f.first, '开始录制轨迹');
  const record = dialog(f.document);
  assert.match(record.textContent ?? '', /录制服务器输入轨迹/u);
  await click(f.first, '设备步骤');
  assert.equal(record.isConnected, false, '切离轨迹页签必须撤销所属录制确认');
  // 旧引用仅验证失活入口不登记恢复后复活的确认，不代表用户能够点击隐藏内容。
  await act(async () => { clickTrigger.click(); recordTrigger.click(); });
  await click(f.first, '桌面操作');
  assert.equal(f.document.querySelector('[role="dialog"]'), null, '页签往返不恢复旧确认');
  assert.equal(field(f.first, '点击间隔（ms）') === interval, true);
  assert.equal(interval.value, '765');
  await click(f.first, '执行连续点击');
  const repeat = dialog(f.document);
  await f.secondInstance();
  await click(f.second, '桌面操作');
  const otherDraft = field(f.second, '点击间隔（ms）');
  await type(otherDraft, '876');
  await click(f.second, '执行一次点击');
  const other = [...f.document.querySelectorAll('[role="dialog"]')].find((element) => element !== repeat);
  assert.ok(other);
  const focused = f.document.activeElement; assert.ok(other.contains(focused));
  const observedReads = f.reads();
  await f.visible(false);
  assert.equal(repeat.isConnected, false, '隐藏工作区必须撤销所属连续点击确认');
  assert.equal(shell(f.first).hidden, true);
  assert.equal(shell(f.first).hasAttribute('inert'), true);
  assert.equal(other.isConnected, true);
  assert.equal(f.document.activeElement === focused, true, '隐藏旧页面不能夺另一实例焦点');
  await f.visible(true);
  assert.equal(f.document.querySelectorAll('[role="dialog"]').length, 1);
  assert.equal(f.document.activeElement === focused, true);
  assert.equal(interval.value, '765'); assert.equal(otherDraft.value, '876');
  await click(other, '返回修改');
  await click(f.first, '输入录制与回放');
  assert.equal(field(f.first, '回放轨迹产物 ID') === artifact, true);
  assert.equal(artifact.value, 'memory-trace-artifact');
  await click(f.first, '回放输入轨迹');
  const playback = dialog(f.document);
  await f.visible(false); await f.visible(true);
  assert.equal(playback.isConnected, false);
  assert.equal(f.document.querySelector('[role="dialog"]'), null);
  assert.equal(f.reads(), observedReads, '切页和确认显隐不得新增操作目录读取');
  assert.equal(f.unexpected(), 0, '没有提交、取消、读取任务、设备或输入操作');
  assert.equal(f.network(), 0);
});

test('自动化确认可见性：初始隐藏校准，恢复后Escape返入口，卸载不复活旧确认', async (unit) => {
  const f = await fixture(unit);
  await f.visible(false);
  const release = await f.mount(f.instanceId, f.first);
  assert.equal(shell(f.first).hidden, true, '首次挂载必须校准公开实例的隐藏快照');
  assert.equal(shell(f.first).hasAttribute('inert'), true);
  const oldClick = button(f.first, '执行一次点击');
  const oldRecord = button(f.first, '开始录制轨迹');
  // 程序触发隐藏旧入口仅检查防复活，不表示隐藏入口可由用户操作。
  await act(async () => { oldClick.click(); oldRecord.click(); });
  assert.equal(f.document.querySelector('[role="dialog"]'), null);
  await f.visible(true);
  await click(f.first, '桌面操作');
  assert.equal(f.document.querySelector('[role="dialog"]'), null);
  const draft = field(f.first, '点击间隔（ms）'); await type(draft, '654');
  const trigger = await click(f.first, '执行一次点击');
  const own = dialog(f.document);
  await act(async () => { own.dispatchEvent(new f.browser.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  assert.equal(own.isConnected, false);
  assert.equal(f.document.activeElement === trigger, true, '正常Escape关闭应返回实际触发入口');
  assert.equal(field(f.first, '点击间隔（ms）') === draft, true);
  assert.equal(draft.value, '654');
  await click(f.first, '输入录制与回放');
  assert.equal(f.document.querySelector('[role="dialog"]'), null);
  await click(f.first, '开始录制轨迹');
  assert.ok(dialog(f.document));
  await act(async () => { await release(); });
  assert.equal(f.first.childElementCount, 0);
  assert.equal(f.document.querySelector('[role="dialog"]'), null);
  await f.visible(false); await f.visible(true);
  assert.equal(f.first.childElementCount, 0);
  assert.equal(f.document.querySelector('[role="dialog"]'), null);
  assert.equal(f.unexpected(), 0); assert.equal(f.network(), 0);
});
