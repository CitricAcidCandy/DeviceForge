import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { act, createElement, useState } from 'react';
import { JSDOM } from 'jsdom';
import type { Dispose } from '../src/plugin-sdk/index.ts';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';

// 先建立DOM再导入真实弹层，避免Radix按无文档环境选择副作用实现。
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
const { hostUi } = await import('../src/plugin-sdk/index.ts');
const { resolveOwnedPortalRoot } = await import('../src/app/portal-ownership.ts');
const dialogs = await import('../plugins/settings/src/view/dialogs.tsx');
const releaseUi = installPublicUi();
after(async () => {
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await releaseUi(); imports.dispose(); page.window.close();
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  }
});

function Confirmation() {
  const [open, setOpen] = useState(false);
  return createElement(dialogs.Dialog, { open, onOpenChange: setOpen },
    createElement('input', { 'aria-label': '设置草稿', defaultValue: '未保存的设置内容' }),
    createElement(dialogs.DialogTrigger, { asChild: true },
      createElement(hostUi().Button, { variant: 'outline' }, '删除此配置区')),
    createElement(dialogs.DialogContent, null,
      createElement(dialogs.DialogHeader, null,
        createElement(dialogs.DialogTitle, null, '删除配置区 appearance'),
        createElement(dialogs.DialogDescription, null, '仅确认当前配置区，保持其他设置。')),
      createElement(dialogs.DialogFooter, null,
        createElement(hostUi().Button, { variant: 'outline', onClick: () => setOpen(false) }, '保留配置'))));
}

function button(root: ParentNode, label: string): HTMLButtonElement {
  const element = [...root.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent?.trim() === label);
  assert.ok(element, `缺少设置弹窗操作：${label}`); return element;
}
async function settle() {
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
}

async function fixture() {
  const parent = document.createElement('main'); document.body.append(parent);
  let releaseParent: Dispose = () => {}, releaseChild: Dispose = () => {};
  await act(async () => {
    releaseParent = hostUi().mountReact(parent, createElement('div', null,
      createElement('input', { 'aria-label': '父页面草稿', defaultValue: '保留父页面内容' }),
      createElement('input', { 'aria-label': '其他业务草稿', defaultValue: '保留其他业务内容' }),
      createElement('div', { 'data-testid': 'settings-child' })));
  });
  const root = parent.querySelector<HTMLElement>('[data-testid="settings-child"]'); assert.ok(root);
  root.dataset.deviceforgePlugin = 'deviceforge_settings';
  root.dataset.deviceforgeGeneration = '8';
  root.dataset.deviceforgeExtension = 'workspace.settings.confirmation.1';
  await act(async () => { releaseChild = hostUi().mountReact(root, createElement(Confirmation)); });
  const draft = root.querySelector<HTMLInputElement>('input[aria-label="设置草稿"]'); assert.ok(draft);
  const parentDraft = parent.querySelector<HTMLInputElement>('input[aria-label="父页面草稿"]'); assert.ok(parentDraft);
  const otherDraft = parent.querySelector<HTMLInputElement>('input[aria-label="其他业务草稿"]'); assert.ok(otherDraft);
  const trigger = button(root, '删除此配置区');
  return {
    parent, root, draft, parentDraft, otherDraft, trigger,
    async open() {
      trigger.focus(); await act(async () => { trigger.click(); }); await settle();
      const contents = document.querySelectorAll<HTMLElement>('[role="dialog"]');
      assert.equal(contents.length, 1); const content = contents[0]; assert.ok(content); return content;
    },
    async release() { await act(async () => { await releaseChild(); }); await settle(); },
    async dispose() {
      try {
        await act(async () => { await releaseChild(); await releaseParent(); }); await settle();
      } finally { parent.remove(); }
    },
  };
}

test('设置确认使用所属Portal，Escape及保留配置返回触发按钮且不重建草稿', async () => {
  const f = await fixture();
  try {
    const content = await f.open();
    assert.equal(f.root.contains(content), false, '弹层仍呈现在body而非业务容器内部');
    assert.equal(document.body.contains(content), true);
    assert.ok(resolveOwnedPortalRoot(content)?.anchor === f.root, '设置确认必须归属当前设置挂载');
    await act(async () => {
      (document.activeElement ?? content).dispatchEvent(new page.window.KeyboardEvent('keydown', {
        key: 'Escape', code: 'Escape', bubbles: true, cancelable: true,
      }));
    });
    await settle();
    assert.equal(content.isConnected, false); assert.equal(document.activeElement, f.trigger);
    const reopened = await f.open();
    await act(async () => { button(reopened, '保留配置').click(); }); await settle();
    assert.equal(reopened.isConnected, false); assert.equal(document.activeElement, f.trigger);
    assert.equal(f.root.querySelector('input[aria-label="设置草稿"]'), f.draft);
    assert.equal(f.draft.value, '未保存的设置内容');
    assert.equal(f.parent.querySelector('input[aria-label="父页面草稿"]'), f.parentDraft);
    assert.equal(f.parentDraft.value, '保留父页面内容');
  } finally { await f.dispose(); }
});

test('设置子挂载卸载撤销确认弹层，父页面和其他业务草稿保持原DOM', async () => {
  const f = await fixture();
  try {
    const content = await f.open();
    assert.ok(resolveOwnedPortalRoot(content)?.anchor === f.root, '卸载前确认弹层必须归属当前设置挂载');
    await f.release();
    assert.equal(content.isConnected, false); assert.equal(resolveOwnedPortalRoot(content), null);
    assert.equal(content.hasAttribute('data-deviceforge-portal'), false);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(f.parent.querySelector('input[aria-label="父页面草稿"]'), f.parentDraft);
    assert.equal(f.parent.querySelector('input[aria-label="其他业务草稿"]'), f.otherDraft);
    assert.equal(f.parentDraft.value, '保留父页面内容'); assert.equal(f.otherDraft.value, '保留其他业务内容');
    assert.equal(f.parent.isConnected, true);
  } finally { await f.dispose(); }
});
