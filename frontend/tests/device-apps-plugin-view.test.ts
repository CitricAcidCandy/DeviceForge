import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import type { Dispose, WorkspaceInstance, WorkspaceViewContext } from '../src/plugin-sdk/index.ts';
import { createDeviceAppsServices } from '../plugins/device-apps/src/services.ts';
import type { DeviceAppsServices } from '../plugins/device-apps/src/services.ts';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';
import { fixture as modelFixture, reference } from './device-apps-plugin-fixtures.ts';

async function fixture(options: { replayOperations?: boolean } = {}) {
  const parser = registerCompositionStartupImports();
  assert.deepEqual(parser.diagnostics, []);
  const browser = new JSDOM('<!doctype html><html><body><div id="one"></div><div id="two"></div></body></html>',
    { url: 'http://127.0.0.1:7031', pretendToBeVisual: true });
  // 内存 DOM 没有布局滚动；此夹具只验证真实组件状态与菜单内容。
  browser.window.HTMLElement.prototype.scrollIntoView = () => {};
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: browser.window, document: browser.window.document, navigator: browser.window.navigator,
    HTMLElement: browser.window.HTMLElement, Element: browser.window.Element, Node: browser.window.Node,
    NodeFilter: browser.window.NodeFilter, HTMLSelectElement: browser.window.HTMLSelectElement,
    DocumentFragment: browser.window.DocumentFragment, HTMLInputElement: browser.window.HTMLInputElement,
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
  const { installPublicUi } = await import('../src/app/public-ui.ts');
  const removeUi = installPublicUi();
  const { mountDeviceApps } = await import('../plugins/device-apps/src/view.tsx');
  const base = modelFixture(options), mounted: Dispose[] = [];
  const roots = ['one', 'two'].map((id) => browser.window.document.getElementById(id))
    .filter((root): root is HTMLElement => root !== null);
  const one = createDeviceAppsServices(base.context, reference);
  const two = createDeviceAppsServices(base.context, reference);
  function view(id: string) {
    let current: WorkspaceInstance = {
      instanceId: id, workspaceId: 'apps_unit.workspace', pluginId: 'apps_unit',
      provider: { pluginId: 'deviceforge_device_apps', viewId: 'deviceforge_device_apps.main' },
      target: { kind: 'device', reference: { ...reference } }, visible: true,
      generation: 1, providerGeneration: 1, state: 'ready', reason: null,
    };
    const listeners = new Set<(visible: boolean) => void>();
    const instance: WorkspaceViewContext = {
      signal: base.context.signal, snapshot: () => current,
      subscribeVisibility(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
    return {
      instance,
      setVisible(visible: boolean) {
        current = { ...current, visible };
        for (const listener of [...listeners]) listener(visible);
      },
    };
  }
  async function mount(target: HTMLElement, services: DeviceAppsServices, instance: WorkspaceViewContext) {
    let release: Dispose = () => {};
    await act(async () => { release = mountDeviceApps(target, services, instance); });
    mounted.push(release);
    return release;
  }
  return {
    base, browser, roots, one, two, view, mount,
    async dispose() {
      try {
        await act(async () => {
          for (const release of mounted) await release();
          await base.dispose();
        });
      } finally {
        await removeUi(); parser.dispose(); browser.window.close();
        for (const [name, descriptor] of saved) {
          if (descriptor) Object.defineProperty(globalThis, name, descriptor);
          else Reflect.deleteProperty(globalThis, name);
        }
      }
    },
  };
}

function search(root: ParentNode) {
  const input = root.querySelector<HTMLInputElement>('input[aria-label="筛选应用标识"]');
  assert.ok(input);
  return input;
}
async function type(input: HTMLInputElement, text: string) {
  const browser = input.ownerDocument.defaultView;
  assert.ok(browser);
  const setter = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set;
  assert.ok(setter);
  await act(async () => {
    setter.call(input, text);
    input.dispatchEvent(new browser.Event('input', { bubbles: true }));
  });
}
function button(root: ParentNode, text: string) {
  const result = [...root.querySelectorAll<HTMLButtonElement>('button')]
    .find((item) => item.textContent === text);
  assert.ok(result, `没有找到按钮：${text}`);
  return result;
}

test('原应用界面不自动读取，隐藏及DOM重挂保留草稿，多实例字段和上传标签独立', async () => {
  const f = await fixture(), [root, other] = f.roots;
  assert.ok(root && other);
  try {
    const instance = f.view('apps.one');
    const release = await f.mount(root, f.one, instance.instance);
    assert.match(root.textContent ?? '', /安装到当前设备/);
    await type(search(root), 'com.example');
    await act(async () => { instance.setVisible(false); });
    assert.equal(root.querySelector('[data-device-view]')?.hasAttribute('hidden'), true);
    assert.equal(search(root).value, 'com.example');
    await act(async () => { instance.setVisible(true); await release(); });
    await f.mount(root, f.one, instance.instance);
    assert.equal(search(root).value, 'com.example');
    await f.mount(other, f.two, f.view('apps.two').instance);
    assert.equal(search(other).value, '');
    const upload = root.querySelector<HTMLInputElement>('input[type="file"]');
    const secondUpload = other.querySelector<HTMLInputElement>('input[type="file"]');
    assert.ok(upload && secondUpload);
    assert.notEqual(upload.id, secondUpload.id);
    assert.ok(root.querySelector(`label[for="${upload.id}"]`));
    assert.equal(f.base.counts.invocations, 0);
    assert.equal(f.base.counts.uploads, 0);
  } finally { await f.dispose(); }
});

test('显式读取展示真实应用行和详情菜单；隐藏关闭Portal，原安装与7种分析操作仍在', async () => {
  const f = await fixture({ replayOperations: false }), root = f.roots[0];
  assert.ok(root);
  try {
    const instance = f.view('apps.one');
    await f.mount(root, f.one, instance.instance);
    const read = root.querySelector<HTMLButtonElement>('button[aria-label="读取应用列表"]');
    assert.ok(read);
    assert.equal(f.base.counts.operationReads, 0);
    assert.equal(read.disabled, false);
    await act(async () => { read.click(); });
    assert.equal(f.base.counts.operationReads, 1);
    assert.equal(f.base.counts.invocations, 1);
    assert.match(root.textContent ?? '', /com.example.app/);
    const menu = root.querySelector<HTMLButtonElement>('button[aria-label="com.example.app 的操作"]');
    assert.ok(menu);
    await act(async () => { menu.click(); });
    await act(async () => { instance.setVisible(false); });
    assert.equal(f.browser.window.document.querySelector('[role="menu"]'), null);
    await act(async () => { instance.setVisible(true); });
    await act(async () => { button(root, '安装包分析').click(); });
    const dialog = f.browser.window.document.querySelector('[role="dialog"]');
    assert.ok(dialog);
    assert.match(dialog.textContent ?? '', /安装包处理方式|处理方式/);
    const selector = dialog.querySelector<HTMLButtonElement>('button[aria-label="安装包处理方式"]');
    assert.ok(selector);
    assert.equal(selector.textContent, '清单');
    await act(async () => { selector.click(); });
    const options = [...f.browser.window.document.querySelectorAll('[role="option"]')]
      .map((option) => option.textContent);
    assert.deepEqual(options, ['清单', '签名', '提取 APK', 'AAB 构建', '反编译', 'SDK 规则', 'APKS 匹配']);
    await act(async () => { instance.setVisible(false); });
    assert.equal(f.browser.window.document.querySelector('[role="dialog"]'), null);
    assert.equal(f.base.counts.invocations, 1);
    assert.equal(f.base.counts.uploads, 0);
  } finally { await f.dispose(); }
});
