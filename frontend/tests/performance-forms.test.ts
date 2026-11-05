import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after } from 'node:test';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import { compile } from 'tailwindcss';
import type { DeviceSnapshot, Dispose, HostContext, ProvidedDevice } from '../src/plugin-sdk/index.ts';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';

// 首次导入公开UI及Radix之前建立DOM，验证真实表单和所属弹层。
const page = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  url: 'http://127.0.0.1:7031/#/performance', pretendToBeVisual: true,
});
const document = page.window.document;
const previous = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: page.window, document, navigator: page.window.navigator,
  Element: page.window.Element, HTMLElement: page.window.HTMLElement, Document: page.window.Document,
  HTMLInputElement: page.window.HTMLInputElement, HTMLButtonElement: page.window.HTMLButtonElement,
  HTMLFormElement: page.window.HTMLFormElement, HTMLSelectElement: page.window.HTMLSelectElement,
  DocumentFragment: page.window.DocumentFragment, Node: page.window.Node, NodeFilter: page.window.NodeFilter,
  MutationObserver: page.window.MutationObserver, Event: page.window.Event, CustomEvent: page.window.CustomEvent,
  MouseEvent: page.window.MouseEvent, KeyboardEvent: page.window.KeyboardEvent, FocusEvent: page.window.FocusEvent,
  getComputedStyle: page.window.getComputedStyle.bind(page.window),
  requestAnimationFrame: page.window.requestAnimationFrame.bind(page.window),
  cancelAnimationFrame: page.window.cancelAnimationFrame.bind(page.window), IS_REACT_ACT_ENVIRONMENT: true,
})) {
  previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
const style = document.createElement('style');
// 载入当前共享表单的真实遗留规则，仅判断144px固定列，不推导浏览器几何。
style.textContent = readFileSync(new URL('../src/components/Form/styles.css', import.meta.url), 'utf8');
document.head.append(style);
const imports = registerCompositionStartupImports();
const { installPublicUi } = await import('../src/app/public-ui.ts');
const { hostUi } = await import('../src/plugin-sdk/index.ts');
const { resolveOwnedPortalRoot } = await import('../src/app/portal-ownership.ts');
const releaseUi = installPublicUi();
const { PerformancePage } = await import('../plugins/performance/src/view.tsx');
const { createPerformanceServices } = await import('../plugins/performance/src/services.ts');
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
  assert.ok(found, `缺少性能表单操作：${text}`); return found;
}
function control(root: ParentNode, text: string) {
  const label = [...root.querySelectorAll('label')].find((element) => element.textContent?.trim() === text);
  assert.ok(label, `缺少性能表单标签：${text}`);
  const element = document.getElementById(label.htmlFor);
  assert.ok(element && root.contains(element), `标签必须指向本性能实例：${text}`);
  return { label, element };
}
function input(root: ParentNode, text: string) {
  const found = control(root, text).element;
  assert.ok(found instanceof page.window.HTMLInputElement); return found;
}
async function edit(element: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(page.window.HTMLInputElement.prototype, 'value')?.set;
    assert.ok(setter); setter.call(element, value);
    element.dispatchEvent(new page.window.Event('input', { bubbles: true }));
  });
}
async function pressEscape() {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(new page.window.KeyboardEvent('keydown', {
      key: 'Escape', code: 'Escape', bubbles: true, cancelable: true,
    }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}
function ownedDialog(root: HTMLElement) {
  const content = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((element) =>
    resolveOwnedPortalRoot(element)?.anchor === root);
  assert.ok(content, '弹层应属于当前公开挂载根'); return content;
}
async function fixture(id: string) {
  const owner = new AbortController();
  let calls = 0;
  const unavailable = async (): Promise<never> => { calls++; throw new Error('表单单元禁止真实任务、采集和设备调用'); };
  const reference = { providerId: 'android-device', generation: 'g1', localId: id };
  const selected: ProvidedDevice = { reference, state: 'online', model: id, capabilities: [] };
  const provider = { id: 'android-device', generation: 'g1', version: '1',
    definition: { apiVersion: 1, platform: 'Android', discoverOperation: 'discover', capabilities: [] } };
  const snapshot: DeviceSnapshot = { selection: reference, selected, providers: [provider],
    directories: [{ provider, observedAt: 1, discoveryJobId: 'observed', devices: [selected] }] };
  const context: HostContext = {
    apiVersion: 2, signal: owner.signal, submit: unavailable, getJob: unavailable, cancelJob: unavailable,
    listOperations: async () => ({ data: [{ id: 'android.performance.start', title: '开始采集', input_schema: {} }], logId: null }),
    subscribeOperations: () => () => {}, onDispose: (release) => release, onCleanup: () => () => {},
    artifacts: { upload: unavailable, download: unavailable },
    devices: { snapshot: () => snapshot, subscribe: () => () => {}, select: () => {},
      refreshProviders: unavailable, refreshDirectories: unavailable, refreshProvider: unavailable, invoke: unavailable },
  };
  const services = createPerformanceServices(context);
  const root = document.createElement('main'); document.body.append(root);
  root.dataset.deviceforgePlugin = 'deviceforge_performance'; root.dataset.deviceforgeGeneration = '1';
  root.dataset.deviceforgeExtension = `performance.${id}`;
  let release: Dispose = () => {};
  try {
    await act(async () => { release = hostUi().mountReact(root, createElement(PerformancePage, { services })); });
  } catch (error) {
    try { await act(async () => { await release(); }); }
    finally { owner.abort(); services.dispose(); root.remove(); }
    throw error;
  }
  return { root, calls: () => calls,
    async dispose() {
      try { await act(async () => { await release(); }); }
      finally { owner.abort(); services.dispose(); root.remove(); }
    },
  };
}

test('性能归档多实例标签只切换所属采样画面，时长和归档输入草稿互不覆盖', async () => {
  const first = await fixture('first'), second = await fixture('second');
  try {
    await act(async () => { button(first.root, '归档录制').click(); button(second.root, '归档录制').click(); });
    const firstSwitch = control(first.root, '采样画面'), secondSwitch = control(second.root, '采样画面');
    await act(async () => { secondSwitch.label.click(); });
    assert.equal(firstSwitch.element.getAttribute('aria-checked'), 'true');
    assert.equal(secondSwitch.element.getAttribute('aria-checked'), 'false');
    const duration = input(second.root, '时长（秒）'), interval = input(second.root, '间隔（毫秒）');
    await edit(duration, '9'); await edit(interval, '2000');
    assert.equal(input(first.root, '时长（秒）').value, '5');
    assert.equal(input(first.root, '间隔（毫秒）').value, '1000');
    await act(async () => { button(second.root, '归档与导出').click(); });
    const drawer = ownedDialog(second.root), restore = input(drawer, '录制任务 ID');
    await edit(restore, 'second-draft-job');
    await pressEscape();
    assert.equal(drawer.isConnected, false);
    await act(async () => { button(second.root, '归档与导出').click(); });
    assert.equal(input(ownedDialog(second.root), '录制任务 ID').value, 'second-draft-job');
    assert.equal(input(second.root, '时长（秒）').value, '9');
    assert.equal(input(second.root, '间隔（毫秒）').value, '2000');
    for (const root of [first.root, second.root, ownedDialog(second.root)]) {
      for (const label of root.querySelectorAll<HTMLLabelElement>('label[for]'))
        assert.equal(root.contains(document.getElementById(label.htmlFor)), true, '标签不得指向其他性能实例');
    }
    assert.equal(first.calls(), 0); assert.equal(second.calls(), 0);
  } finally { await first.dispose(); await second.dispose(); }
});

test('性能采集弹窗输入不继承144px标签列，独立标签及取消重开保留本实例草稿', async () => {
  const first = await fixture('collect-first'), second = await fixture('collect-second');
  try {
    await act(async () => { button(first.root, '开始采集').click(); });
    await act(async () => { button(second.root, '开始采集').click(); });
    const firstDialog = ownedDialog(first.root), secondDialog = ownedDialog(second.root);
    const fields = control(secondDialog, '应用包名').label.parentElement?.parentElement;
    assert.ok(fields);
    // 编译真实DOM上的工具类，证明适配规则实际生成；不把它当浏览器尺寸验收。
    const compiler = await compile('@theme { --spacing: 0.25rem; } @tailwind utilities;');
    const css = compiler.build([...fields.classList, ...secondDialog.classList]);
    assert.match(css, /grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(220px,\s*100%\),\s*1fr\)\)/);
    assert.match(css, /max-height:\s*calc\(100dvh\s*-\s*2rem\)/);
    assert.match(css, /overflow-y:\s*auto/);
    for (const dialog of [firstDialog, secondDialog]) {
      for (const name of ['应用包名', '时长（秒）', '间隔（毫秒）']) {
        const field = control(dialog, name).label.parentElement;
        assert.ok(field);
        assert.doesNotMatch(page.window.getComputedStyle(field).gridTemplateColumns, /144px/,
          '采集输入的标签应在上方，不得遗留共享表单144px标签列');
      }
      for (const label of dialog.querySelectorAll<HTMLLabelElement>('label[for]'))
        assert.equal(dialog.contains(document.getElementById(label.htmlFor)), true, '采集弹层标签应属于当前实例');
    }
    const firstLaunch = control(firstDialog, '先启动应用'), secondLaunch = control(secondDialog, '先启动应用');
    await act(async () => { secondLaunch.label.click(); });
    assert.equal(firstLaunch.element.getAttribute('aria-checked'), 'true');
    assert.equal(secondLaunch.element.getAttribute('aria-checked'), 'false');
    await edit(input(secondDialog, '应用包名'), 'org.example.second');
    await edit(input(secondDialog, '时长（秒）'), '120');
    await edit(input(secondDialog, '间隔（毫秒）'), '250');
    assert.equal(input(firstDialog, '应用包名').value, '');
    assert.equal(input(firstDialog, '时长（秒）').value, '60');
    await act(async () => { button(secondDialog, '取消').click(); });
    assert.equal(secondDialog.isConnected, false); assert.equal(firstDialog.isConnected, true);
    await act(async () => { button(second.root, '开始采集').click(); });
    const reopened = ownedDialog(second.root);
    assert.equal(input(reopened, '应用包名').value, 'org.example.second');
    assert.equal(input(reopened, '时长（秒）').value, '120');
    assert.equal(input(reopened, '间隔（毫秒）').value, '250');
    assert.equal(control(reopened, '先启动应用').element.getAttribute('aria-checked'), 'false');
    await first.dispose();
    assert.equal(firstDialog.isConnected, false); assert.equal(reopened.isConnected, true);
    assert.equal(resolveOwnedPortalRoot(reopened)?.anchor === second.root, true);
    assert.equal(input(reopened, '应用包名').value, 'org.example.second');
    assert.equal(first.calls(), 0); assert.equal(second.calls(), 0);
  } finally { await first.dispose(); await second.dispose(); }
});
