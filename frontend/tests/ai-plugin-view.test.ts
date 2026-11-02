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
