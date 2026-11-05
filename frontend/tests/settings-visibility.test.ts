import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { act } from 'react';
import { JSDOM } from 'jsdom';
import type { Dispose, HostContext, JsonValue, WorkspaceViewContext } from '../src/plugin-sdk/index.ts';
import { createWorkspaceRegistry } from '../src/plugins/workspace/index.ts';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';

// 先建立文档再导入真实公开弹层，所有配置响应只来自当前内存夹具。
const page = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://127.0.0.1:7031/#/settings', pretendToBeVisual: true,
});
const document = page.window.document;
const previous = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: page.window, document, navigator: page.window.navigator,
  Element: page.window.Element, HTMLElement: page.window.HTMLElement, Document: page.window.Document,
  HTMLInputElement: page.window.HTMLInputElement, HTMLButtonElement: page.window.HTMLButtonElement,
  HTMLSelectElement: page.window.HTMLSelectElement, HTMLTextAreaElement: page.window.HTMLTextAreaElement,
  HTMLFormElement: page.window.HTMLFormElement, DocumentFragment: page.window.DocumentFragment,
  Node: page.window.Node, NodeFilter: page.window.NodeFilter, MutationObserver: page.window.MutationObserver,
  Event: page.window.Event, CustomEvent: page.window.CustomEvent, MouseEvent: page.window.MouseEvent,
  KeyboardEvent: page.window.KeyboardEvent, FocusEvent: page.window.FocusEvent,
  getComputedStyle: page.window.getComputedStyle.bind(page.window),
  requestAnimationFrame: page.window.requestAnimationFrame.bind(page.window),
  cancelAnimationFrame: page.window.cancelAnimationFrame.bind(page.window), IS_REACT_ACT_ENVIRONMENT: true,
})) {
  previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
const imports = registerCompositionStartupImports();
const { installPublicUi } = await import('../src/app/public-ui.ts');
const { resolveOwnedPortalRoot } = await import('../src/app/portal-ownership.ts');
const { createSettingsPlugin } = await import('../plugins/settings/src/index.ts');
const releaseUi = installPublicUi();
after(async () => {
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await releaseUi(); imports.dispose(); page.window.close();
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  }
});

function button(root: ParentNode, label: string) {
  const found = [...root.querySelectorAll<HTMLButtonElement>('button')]
    .find((element) => element.textContent?.trim() === label);
  assert.ok(found, `缺少设置操作：${label}`); return found;
}
function textarea(root: HTMLElement, text: string) {
  const label = [...root.querySelectorAll('label')].find((element) => element.textContent?.trim() === text);
  assert.ok(label, `缺少设置标签：${text}`);
  const element = document.getElementById(label.htmlFor);
  assert.ok(element instanceof page.window.HTMLTextAreaElement && root.contains(element));
  return element;
}
async function edit(element: HTMLTextAreaElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(page.window.HTMLTextAreaElement.prototype, 'value')?.set;
    assert.ok(setter); setter.call(element, value);
    element.dispatchEvent(new page.window.Event('input', { bubbles: true }));
  });
}
function dialogs() { return [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]; }

async function fixture(options: { initialVisible?: boolean; hideDuringSubscribe?: boolean } = {}) {
  const controller = new AbortController(), registry = createWorkspaceRegistry();
  const releases: Dispose[] = [];
  const calls: { operation: string; input: JsonValue }[] = [];
  const ui = registry.access({ pluginId: 'deviceforge_settings', generation: 8, signal: controller.signal });
  const context: HostContext = {
    apiVersion: 2, signal: controller.signal, ui,
    listOperations: async () => ({ data: ['list', 'get', 'set', 'delete', 'import'].map((action) => ({
      id: `plugin.settings.${action}`, title: `设置${action}`, input_schema: {},
    })), logId: 'settings-operations' }),
    submit: async (operation, input) => {
      calls.push({ operation, input });
      if (operation !== 'plugin.settings.get') throw new Error('本单元只允许显式内存配置读取');
      return { data: { id: 'settings-read-1', operation, status: 'succeeded', error: null,
        result: { result: { format_version: 1, revision: '73', section: 'general', value: { theme: 'baseline' } }, artifacts: [] },
      }, logId: 'settings-read' };
    },
    getJob: async () => { throw new Error('终态内存任务不应轮询'); },
    cancelJob: async () => { throw new Error('显隐不应取消手动作业'); },
    subscribeOperations: () => () => {},
    onDispose: (release) => { releases.push(release); return release; },
  };
  const plugin = createSettingsPlugin({ id: 'deviceforge_settings', version: '0.1.0', apiVersion: 2 });
  assert.ok(plugin.activate); await plugin.activate(context);
  const instanceId = 'deviceforge_settings.editor.main';
  ui.setVisible(instanceId, options.initialVisible ?? true);
  const resolved = registry.resolveView(instanceId); assert.ok(resolved);
  let hideBeforeSubscribe = options.hideDuringSubscribe ?? false, subscriptions = 0;
  const instance: WorkspaceViewContext = {
    signal: resolved.instance.signal, snapshot: () => resolved.instance.snapshot(),
    subscribeVisibility(listener) {
      // 模拟渲染读取之后、登记监听之前漏掉的可见性变化。
      if (hideBeforeSubscribe) { hideBeforeSubscribe = false; ui.setVisible(instanceId, false); }
      subscriptions++;
      const release = resolved.instance.subscribeVisibility(listener);
      return async () => { subscriptions--; await release(); };
    },
  };
  const root = document.createElement('div');
  root.dataset.deviceforgePlugin = 'deviceforge_settings'; root.dataset.deviceforgeGeneration = '8';
  root.dataset.deviceforgeExtension = instanceId;
  document.body.append(root);
  let release: Dispose | undefined;
  await act(async () => { release = await resolved.definition.mount(root, context, instance); });
  const shell = root.firstElementChild; assert.ok(shell instanceof page.window.HTMLElement);
  const draft = textarea(root, '配置内容 · JSON');
  const imported = textarea(root, '配置区集合 · JSON');
  return {
    root, shell, calls, draft, imported,
    async choose(name: string) { await act(async () => { button(root, name).click(); }); },
    async read() {
      await act(async () => { button(root, '工具配置').click(); });
      await act(async () => { button(root, '读取此区').click(); });
      assert.ok(root.textContent?.includes('当前修订：73'), '显式内存读取必须取得真实修订元数据');
      const summary = [...root.querySelectorAll('summary')].find((element) => element.textContent?.trim() === '导入与远端配置');
      assert.ok(summary); await act(async () => { summary.click(); });
    },
    async open() { await act(async () => { button(root, '删除此配置区').click(); }); },
    async visible(visible: boolean) { await act(async () => { ui.setVisible(instanceId, visible); }); },
    async dispose() {
      await act(async () => {
        await release?.(); controller.abort();
        for (const dispose of releases.reverse()) await dispose();
        registry.dispose();
      });
      root.remove(); assert.equal(subscriptions, 0);
    },
  };
}

test('设置实例可见性：页面或分类隐藏撤所属确认，恢复保草稿修订且不重读写或夺其他实例焦点', async () => {
  const first = await fixture(), second = await fixture();
  try {
    await first.read(); await second.read();
    await edit(first.draft, '{"草稿":"首个设置"}'); await edit(first.imported, '{"草稿区":{"值":1}}');
    await edit(second.draft, '{"草稿":"其他设置"}');
    await first.open();
    const own = dialogs()[0]; assert.ok(own);
    assert.ok(resolveOwnedPortalRoot(own)?.anchor === first.root);
    await second.open();
    const other = dialogs().find((element) => element !== own); assert.ok(other);
    const otherFocus = document.activeElement; assert.ok(other.contains(otherFocus));
    await first.visible(false);
    assert.ok(!own.isConnected, '设置实例隐藏必须撤销所属删除确认Portal');
    assert.ok(dialogs().length === 1 && other.isConnected);
    assert.ok(document.activeElement === otherFocus, '页面隐藏不能返焦隐藏入口或夺走其他实例焦点');
    await first.open();
    assert.ok(dialogs().length === 1 && other.isConnected, '隐藏旧入口不能打开或登记确认');
    await first.visible(true);
    assert.ok(dialogs().length === 1 && other.isConnected, '恢复不能重开隐藏期间登记的确认');
    assert.ok(textarea(first.root, '配置内容 · JSON') === first.draft);
    assert.ok(textarea(first.root, '配置区集合 · JSON') === first.imported);
    assert.ok(first.draft.value === '{"草稿":"首个设置"}' && first.imported.value === '{"草稿区":{"值":1}}');
    assert.ok(first.root.textContent?.includes('当前修订：73'));
    await first.open();
    const categoryDialog = dialogs().find((element) => element !== other); assert.ok(categoryDialog);
    await first.choose('服务连接');
    assert.ok(!categoryDialog.isConnected, '切出工具配置分类也必须撤销所属确认');
    assert.ok(other.isConnected && document.activeElement !== button(first.root, '删除此配置区'));
    await first.open();
    await first.choose('工具配置');
    assert.ok(dialogs().length === 1 && other.isConnected, '返回分类不能重开隐藏期间的旧确认');
    assert.ok(textarea(first.root, '配置内容 · JSON') === first.draft && first.draft.value === '{"草稿":"首个设置"}');
    assert.ok(textarea(second.root, '配置内容 · JSON') === second.draft && second.draft.value === '{"草稿":"其他设置"}');
    const expected = [{ operation: 'plugin.settings.get', input: { scope: 'user', owner_id: 'local', section: 'general' } }];
    assert.deepEqual(first.calls, expected); assert.deepEqual(second.calls, expected);
  } finally { await first.dispose(); await second.dispose(); }
});

test('设置实例可见性：初始隐藏和订阅前变化校准最新快照，显示保原DOM且不自动读写', async () => {
  for (const options of [{ initialVisible: false }, { hideDuringSubscribe: true }]) {
    const current = await fixture(options);
    try {
      assert.ok(current.shell.hidden, '初始隐藏及登记漏通知必须采用最新实例可见性');
      assert.ok(current.shell.hasAttribute('inert'));
      assert.ok(dialogs().length === 0); assert.deepEqual(current.calls, []);
      await current.visible(true);
      assert.ok(!current.shell.hidden && current.root.firstElementChild === current.shell);
      assert.ok(textarea(current.root, '配置内容 · JSON') === current.draft && current.draft.value === '{}');
      assert.ok(dialogs().length === 0); assert.deepEqual(current.calls, []);
    } finally { await current.dispose(); }
  }
});
