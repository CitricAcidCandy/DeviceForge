import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createFrontendRuntime } from '../src/app/runtime.ts';
import type { Dispose } from '../src/plugin-sdk/index.ts';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';

async function fixture() {
  const parser = registerCompositionStartupImports();
  assert.deepEqual(parser.diagnostics, []);
  const browser = new JSDOM('<!doctype html><html><body><div id="one"></div><div id="two"></div></body></html>',
    { url: 'http://127.0.0.1:7031', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: browser.window, document: browser.window.document, navigator: browser.window.navigator,
    HTMLElement: browser.window.HTMLElement, Element: browser.window.Element, Node: browser.window.Node,
    NodeFilter: browser.window.NodeFilter, HTMLSelectElement: browser.window.HTMLSelectElement,
    DocumentFragment: browser.window.DocumentFragment, HTMLInputElement: browser.window.HTMLInputElement,
    HTMLTextAreaElement: browser.window.HTMLTextAreaElement,
    HTMLFormElement: browser.window.HTMLFormElement, HTMLButtonElement: browser.window.HTMLButtonElement,
    CustomEvent: browser.window.CustomEvent, MutationObserver: browser.window.MutationObserver,
    Event: browser.window.Event, KeyboardEvent: browser.window.KeyboardEvent, FocusEvent: browser.window.FocusEvent,
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
  const { default: createAiPlugin } = await import('../plugins/ai/src/index.ts');
  let network = 0;
  const runtime = createFrontendRuntime({
    baseUrl: 'http://127.0.0.1:7031', workspaceStorage: null, panelTarget: () => null,
    transport: async () => { network++; throw new Error('界面草稿单元禁止联网'); },
  });
  runtime.bundledPlugins.register({ id: 'view_ai', trusted: true,
    plugin: createAiPlugin({ id: 'view_ai', version: '1', apiVersion: 2 }) });
  await runtime.webPlugins.load('view_ai');
  const ui = runtime.host.ui;
  assert.ok(ui?.mount);
  const activeUi = ui;
  const targets = [browser.window.document.getElementById('one'), browser.window.document.getElementById('two')];
  const roots = targets.filter((target): target is HTMLElement => target !== null);
  assert.equal(roots.length, 2);
  const mounted: Dispose[] = [];
  async function mount(id: string, target: HTMLElement) {
    let release: Dispose = () => {};
    await act(async () => {
      assert.ok(activeUi.mount);
      release = await activeUi.mount(id, target, new AbortController().signal);
    });
    mounted.push(release);
    return release;
  }
  return {
    browser, runtime, ui, roots, mount, network: () => network,
    async visible(instanceId: string, visible: boolean) {
      await act(async () => { activeUi.setVisible(instanceId, visible); });
    },
    async dispose() {
      try {
        await act(async () => { for (const release of mounted) await release(); });
        await runtime.dispose();
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
function textarea(target: ParentNode, provider: 'sdk' | 'cli') {
  const input = target.querySelector<HTMLTextAreaElement>(`textarea[id$="-assistant-prompt-${provider}"]`);
  assert.ok(input);
  return input;
}
async function type(input: HTMLTextAreaElement, value: string) {
  const window = input.ownerDocument.defaultView;
  assert.ok(window);
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
  assert.ok(descriptor?.set);
  await act(async () => {
    descriptor.set?.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

test('真实复用界面经公开mount重挂保留草稿，多实例标签唯一且不隐式联网', async () => {
  const f = await fixture();
  const [one, two] = f.roots;
  assert.ok(one && two);
  try {
    const release = await f.mount('view_ai.main.default', one);
    await type(textarea(one, 'sdk'), '这份草稿需要保留');
    await act(async () => { await release(); });
    await f.mount('view_ai.main.default', one);
    assert.equal(textarea(one, 'sdk').value, '这份草稿需要保留');
    f.ui.open({ instanceId: 'host.second', workspaceId: 'view_ai.workspace',
      provider: { pluginId: 'view_ai', viewId: 'view_ai.main' } }, new AbortController().signal);
    await f.mount('host.second', two);
    assert.equal(textarea(two, 'sdk').value, '');
    assert.notEqual(textarea(one, 'sdk').id, textarea(two, 'sdk').id);
    assert.equal(f.network(), 0);
  } finally { await f.dispose(); }
});

test('设置切换提供者关闭旧抽屉，不让隐藏SDK页的Portal遮住CLI；草稿按提供者隔离', async () => {
  const f = await fixture(), root = f.roots[0];
  assert.ok(root);
  try {
    await f.mount('view_ai.main.default', root);
    await type(textarea(root, 'sdk'), 'SDK 草稿');
    const settings = root.querySelector<HTMLButtonElement>('button[aria-label="打开对话设置"]');
    assert.ok(settings);
    await act(async () => { settings.click(); });
    const dialog = f.browser.window.document.querySelector('[role="dialog"]');
    assert.ok(dialog);
    const cli = [...dialog.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Codex CLI');
    assert.ok(cli);
    await act(async () => { cli.click(); });
    assert.equal(f.browser.window.document.querySelector('[role="dialog"]'), null);
    assert.equal(textarea(root, 'cli').value, '');
    assert.equal(textarea(root, 'sdk').value, 'SDK 草稿');
    assert.equal(textarea(root, 'sdk').closest('[hidden]') !== null, true);
    assert.equal(textarea(root, 'cli').closest('[hidden]'), null);
    assert.equal(f.network(), 0);
  } finally { await f.dispose(); }
});

function settingsButton(root: ParentNode) {
  const button = root.querySelector<HTMLButtonElement>('button[aria-label="打开对话设置"]');
  assert.ok(button);
  return button;
}

function aiShell(root: ParentNode) {
  const shell = root.querySelector('[data-product-page="ai"]')?.parentElement;
  assert.ok(shell);
  return shell;
}

test('AI设置实例可见性：隐藏撤所属抽屉，恢复不复活旧入口且保留双实例草稿与焦点', async () => {
  const f = await fixture();
  const [one, two] = f.roots; assert.ok(one && two);
  const document = f.browser.window.document;
  try {
    const releaseFirst = await f.mount('view_ai.main.default', one);
    f.ui.open({ instanceId: 'host.second', workspaceId: 'view_ai.workspace',
      provider: { pluginId: 'view_ai', viewId: 'view_ai.main' } }, new AbortController().signal);
    await f.mount('host.second', two);
    const firstDraft = textarea(one, 'sdk'), secondDraft = textarea(two, 'sdk');
    await type(firstDraft, '首个工作区草稿'); await type(secondDraft, '另一个工作区草稿');
    const shell = aiShell(one);
    const firstSettings = settingsButton(one);
    await act(async () => { firstSettings.click(); });
    const own = document.querySelector('[role="dialog"]'); assert.ok(own);
    await act(async () => { settingsButton(two).click(); });
    const other = [...document.querySelectorAll('[role="dialog"]')].find((dialog) => dialog !== own);
    assert.ok(other);
    const otherFocus = document.activeElement; assert.ok(other.contains(otherFocus));
    assert.equal(f.network(), 0);
    await f.visible('view_ai.main.default', false);
    assert.equal(own.isConnected, false, '隐藏工作区必须撤销该实例设置Portal');
    assert.equal(shell.hidden, true);
    assert.equal(shell.hasAttribute('inert'), true);
    assert.equal(other.isConnected, true, '其他实例设置不受本页隐藏影响');
    assert.equal(document.activeElement === otherFocus, true, '撤销旧设置不能夺走其他实例焦点');
    // 程序触发保留下来的旧入口，验证隐藏期间不能登记恢复后复活的抽屉。
    await act(async () => { firstSettings.click(); });
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 1, '隐藏旧入口不能重新打开设置');
    await f.visible('view_ai.main.default', true);
    assert.equal(shell.hidden, false);
    assert.equal(shell.hasAttribute('inert'), false);
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 1, '恢复不能重开隐藏期间登记的抽屉');
    assert.equal(document.activeElement === otherFocus, true);
    assert.equal(textarea(one, 'sdk') === firstDraft, true);
    assert.equal(textarea(two, 'sdk') === secondDraft, true);
    assert.equal(firstDraft.value, '首个工作区草稿');
    assert.equal(secondDraft.value, '另一个工作区草稿');
    await act(async () => { await releaseFirst(); });
    assert.equal(one.childElementCount, 0);
    await f.visible('view_ai.main.default', false); await f.visible('view_ai.main.default', true);
    assert.equal(one.childElementCount, 0, '卸载后的可见性通知不能重新挂载旧界面');
    assert.equal(other.isConnected, true);
    assert.equal(document.activeElement === otherFocus, true);
    assert.equal(secondDraft.value, '另一个工作区草稿');
    assert.equal(f.network(), 0, '设置显隐不得提交AI、配置检查或目录刷新');
  } finally { await f.dispose(); }
});

test('AI设置实例可见性：初始隐藏拒绝旧入口，恢复可正常开关且卸载后监听不复活', async () => {
  const f = await fixture(), root = f.roots[0]; assert.ok(root);
  const document = f.browser.window.document;
  try {
    await f.visible('view_ai.main.default', false);
    const release = await f.mount('view_ai.main.default', root);
    const shell = aiShell(root);
    const draft = textarea(root, 'sdk'), trigger = settingsButton(root);
    assert.equal(shell.hidden, true, '首次挂载采用真实工作区的隐藏快照');
    assert.equal(shell.hasAttribute('inert'), true);
    // 仅测试隐藏旧引用的防复活守卫，不代表真实用户可操作隐藏入口。
    await act(async () => { trigger.click(); });
    assert.equal(document.querySelector('[role="dialog"]'), null, '初始隐藏的旧入口不能打开Portal');
    await f.visible('view_ai.main.default', true);
    assert.equal(aiShell(root) === shell, true);
    assert.equal(shell.hidden, false);
    assert.equal(shell.hasAttribute('inert'), false);
    assert.equal(textarea(root, 'sdk') === draft, true);
    assert.equal(document.querySelector('[role="dialog"]'), null, '恢复不能自动打开旧设置');
    await type(draft, '恢复显示后保留的草稿');
    await act(async () => { trigger.focus(); trigger.click(); });
    const dialog = document.querySelector('[role="dialog"]'); assert.ok(dialog);
    await act(async () => { dialog.dispatchEvent(new f.browser.window.KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true,
    })); });
    assert.equal(dialog.isConnected, false);
    assert.equal(document.activeElement === trigger, true, '正常Escape关闭应返焦原设置入口');
    assert.equal(textarea(root, 'sdk') === draft, true);
    assert.equal(draft.value, '恢复显示后保留的草稿');
    await act(async () => { trigger.click(); });
    assert.ok(document.querySelector('[role="dialog"]'));
    await act(async () => { await release(); });
    assert.equal(root.childElementCount, 0);
    assert.equal(document.querySelector('[role="dialog"]'), null, '卸载回收所属设置Portal');
    await f.visible('view_ai.main.default', false); await f.visible('view_ai.main.default', true);
    assert.equal(root.childElementCount, 0);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(f.network(), 0);
  } finally { await f.dispose(); }
});
