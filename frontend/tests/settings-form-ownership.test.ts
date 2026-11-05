import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import type { Dispose, HostContext } from '../src/plugin-sdk/index.ts';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';

// 在公开UI首次载入前建立DOM，使用真实控件验证标签归属。
const page = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://127.0.0.1:7031/#/settings', pretendToBeVisual: true,
});
const document = page.window.document;
const previous = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: page.window, document, navigator: page.window.navigator,
  Element: page.window.Element, HTMLElement: page.window.HTMLElement, Document: page.window.Document,
  HTMLInputElement: page.window.HTMLInputElement, HTMLButtonElement: page.window.HTMLButtonElement,
  HTMLFormElement: page.window.HTMLFormElement, HTMLSelectElement: page.window.HTMLSelectElement,
  HTMLTextAreaElement: page.window.HTMLTextAreaElement, DocumentFragment: page.window.DocumentFragment,
  Node: page.window.Node, NodeFilter: page.window.NodeFilter, MutationObserver: page.window.MutationObserver,
  Event: page.window.Event, CustomEvent: page.window.CustomEvent,
  getComputedStyle: page.window.getComputedStyle.bind(page.window),
  requestAnimationFrame: page.window.requestAnimationFrame.bind(page.window),
  cancelAnimationFrame: page.window.cancelAnimationFrame.bind(page.window), IS_REACT_ACT_ENVIRONMENT: true,
})) {
  previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
const imports = registerCompositionStartupImports();
const { installPublicUi } = await import('../src/app/public-ui.ts');
const { hostUi } = await import('../src/plugin-sdk/index.ts');
const releaseUi = installPublicUi();
const { SettingsView } = await import('../plugins/settings/src/view.tsx');
const { createSettingsServices } = await import('../plugins/settings/src/services.ts');
after(async () => {
  await act(async () => {});
  await new Promise<void>((resolve) => setImmediate(resolve));
  await releaseUi(); imports.dispose(); page.window.close();
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  }
});

function button(root: ParentNode, text: string) {
  const found = [...root.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.textContent?.trim() === text);
  assert.ok(found, `缺少设置分类操作：${text}`); return found;
}
function control(root: HTMLElement, text: string) {
  const label = [...root.querySelectorAll('label')].find((element) => element.textContent?.trim() === text);
  assert.ok(label, `缺少设置标签：${text}`);
  const element = document.getElementById(label.htmlFor);
  assert.ok(element && root.contains(element), `标签必须指向当前设置实例：${text}`);
  return { label, element };
}
function textarea(root: HTMLElement, text: string) {
  const element = control(root, text).element;
  assert.ok(element instanceof page.window.HTMLTextAreaElement); return element;
}
async function edit(element: HTMLTextAreaElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(page.window.HTMLTextAreaElement.prototype, 'value')?.set;
    assert.ok(setter); setter.call(element, value);
    element.dispatchEvent(new page.window.Event('input', { bubbles: true }));
  });
}
async function fixture(id: string) {
  const owner = new AbortController();
  let requests = 0;
  const unavailable = async (): Promise<never> => { requests++; throw new Error('设置表单单元禁止真实任务或远端请求'); };
  const context: HostContext = {
    apiVersion: 2, signal: owner.signal, submit: unavailable, getJob: unavailable, cancelJob: unavailable,
    listOperations: async () => ({ data: [], logId: null }), subscribeOperations: () => () => {},
    onDispose: (release) => release, onCleanup: () => () => {},
  };
  const services = createSettingsServices(context, `settings.${id}.sections`, `settings.${id}.workspace`);
  const root = document.createElement('main'); document.body.append(root);
  let release: Dispose = () => {};
  try {
    await act(async () => { release = hostUi().mountReact(root, createElement(SettingsView, { services })); });
  } catch (error) {
    try { await act(async () => { await release(); }); }
    finally { owner.abort(); services.settings.dispose(); services.operations.dispose(); root.remove(); }
    throw error;
  }
  return { root, requests: () => requests,
    async dispose() {
      try { await act(async () => { await release(); }); }
      finally { owner.abort(); services.settings.dispose(); services.operations.dispose(); root.remove(); }
    },
  };
}

test('设置多实例所有分类的标签和控件只属于自身，固定入口不重复身份', async () => {
  const first = await fixture('first'), second = await fixture('second');
  try {
    const expected = ['服务地址', '可选令牌', '市场地址', '界面主题', '配置归属', '归属 ID', '配置区',
      '配置内容 · JSON', '配置区集合 · JSON', '旧工程备份 · 可选择多个 JSON 文件', '兼容配置区',
      '远端内容 · JSON 原值', '保存远端时更新本地备份'];
    for (const root of [first.root, second.root]) {
      for (const text of expected) control(root, text);
      for (const label of root.querySelectorAll<HTMLLabelElement>('label[for]'))
        assert.equal(root.contains(document.getElementById(label.htmlFor)), true, '所有分类的标签应指向所属实例');
    }
    const identities = [...document.querySelectorAll<HTMLElement>('[id]')].map((element) => element.id);
    assert.equal(new Set(identities).size, identities.length, '并存设置工作区不得重复控件及关联标识');
    assert.equal(first.requests(), 0); assert.equal(second.requests(), 0);
  } finally { await first.dispose(); await second.dispose(); }
});

test('设置第二实例远端备份标签只控制自身，JSON草稿切换分类和卸载保持独立', async () => {
  const first = await fixture('draft-first'), second = await fixture('draft-second');
  try {
    await act(async () => { button(first.root, '工具配置').click(); button(second.root, '工具配置').click(); });
    for (const root of [first.root, second.root]) {
      const summary = [...root.querySelectorAll('summary')].find((element) => element.textContent?.trim() === '导入与远端配置');
      assert.ok(summary);
      await act(async () => { summary.click(); });
      assert.equal(summary.parentElement?.hasAttribute('open'), true);
    }
    const firstBackup = control(first.root, '保存远端时更新本地备份');
    const secondBackup = control(second.root, '保存远端时更新本地备份');
    await act(async () => { secondBackup.label.click(); });
    assert.equal(firstBackup.element.getAttribute('aria-checked'), 'true');
    assert.equal(secondBackup.element.getAttribute('aria-checked'), 'false');
    const firstDraft = textarea(first.root, '配置内容 · JSON'), secondDraft = textarea(second.root, '配置内容 · JSON');
    await edit(firstDraft, '{"first":1}'); await edit(secondDraft, '{"second":2}');
    const secondRemote = textarea(second.root, '远端内容 · JSON 原值');
    await edit(secondRemote, '{"remote":"second"}');
    await act(async () => { button(second.root, '服务连接').click(); });
    await act(async () => { button(second.root, '工具配置').click(); });
    assert.equal(textarea(first.root, '配置内容 · JSON') === firstDraft, true);
    assert.equal(textarea(second.root, '配置内容 · JSON') === secondDraft, true);
    assert.equal(textarea(second.root, '远端内容 · JSON 原值') === secondRemote, true);
    assert.equal(firstDraft.value, '{"first":1}'); assert.equal(secondDraft.value, '{"second":2}');
    assert.equal(secondRemote.value, '{"remote":"second"}');
    await first.dispose();
    assert.equal(second.root.isConnected, true);
    assert.equal(textarea(second.root, '配置内容 · JSON') === secondDraft, true);
    assert.equal(secondDraft.value, '{"second":2}');
    assert.equal(control(second.root, '保存远端时更新本地备份').element.getAttribute('aria-checked'), 'false');
    assert.equal(first.requests(), 0); assert.equal(second.requests(), 0);
  } finally { await first.dispose(); await second.dispose(); }
});
