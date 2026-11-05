import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { act, createElement } from 'react';
import type { ReactElement } from 'react';
import { JSDOM } from 'jsdom';
import type { Dispose } from '../src/plugin-sdk/index.ts';
import type { HostUiHolder } from '../src/app/public-ui.ts';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';

async function fixture(unit: TestContext) {
  const parser = registerCompositionStartupImports();
  const browser = new JSDOM('<!doctype html><html><body><main></main></body></html>');
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: browser.window, document: browser.window.document, navigator: browser.window.navigator,
    HTMLElement: browser.window.HTMLElement, Element: browser.window.Element, Node: browser.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  unit.mock.method(globalThis, 'fetch', async () => { throw new Error('标题披露单元不允许联网'); });
  const { installPublicUi } = await import('../src/app/public-ui.ts');
  const { PageTitle } = await import('../src/components/PageTitle/index.tsx');
  const holder: HostUiHolder = {}, releaseUi = installPublicUi(holder);
  const ui = holder.__DEVICEFORGE_HOST_UI__; assert.ok(ui);
  const mountReact = ui.mountReact;
  const releases: Dispose[] = [];
  unit.after(async () => {
    try {
      for (const release of releases.reverse()) await act(async () => { await release(); });
      await releaseUi();
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      parser.dispose(); browser.window.close();
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });
  async function mount(element: ReactElement) {
    const root = browser.window.document.createElement('section');
    browser.window.document.querySelector('main')?.append(root);
    let release: Dispose = () => {};
    await act(async () => { release = mountReact(root, element); });
    releases.push(release);
    return { root, close: async () => { await act(async () => { await release(); }); } };
  }
  return { browser, PageTitle, mount };
}

function disclosure(root: HTMLElement) {
  const button = root.querySelector<HTMLButtonElement>('.page-help button'); assert.ok(button);
  const descriptionId = button.getAttribute('aria-controls'); assert.ok(descriptionId);
  const description = root.ownerDocument.getElementById(descriptionId);
  const view = root.ownerDocument.defaultView; assert.ok(view);
  assert.ok(description instanceof view.HTMLParagraphElement);
  assert.equal(root.contains(description), true, '关联目标必须属于当前标题实例');
  return { button, description, descriptionId };
}

test('两标题说明分别披露且关联唯一，子输入草稿及另一实例不被重建或卸载', async (unit) => {
  const f = await fixture(unit);
  const first = await f.mount(createElement(f.PageTitle, { title: '文件', description: '第一份使用说明',
    children: createElement('input', { 'aria-label': '文件草稿', defaultValue: '初始文件' }) }));
  const second = await f.mount(createElement(f.PageTitle, { title: '分析', description: '第二份使用说明',
    children: createElement('input', { 'aria-label': '分析草稿', defaultValue: '初始分析' }) }));
  const a = disclosure(first.root), b = disclosure(second.root);
  assert.notEqual(a.descriptionId, b.descriptionId, '同一页面多React根的关联ID不能重复');
  assert.equal(a.description.textContent, '第一份使用说明');
  assert.equal(b.description.textContent, '第二份使用说明');
  for (const { button, description } of [a, b]) {
    assert.equal(button.type, 'button');
    assert.equal(button.tabIndex, 0, '使用原生可聚焦button，而非伪造键盘激活');
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    assert.equal(button.hasAttribute('data-slot'), false, '说明不冒充业务动作按钮');
    assert.equal(description.hidden, true);
  }
  const inputA = first.root.querySelector<HTMLInputElement>('input'), inputB = second.root.querySelector<HTMLInputElement>('input');
  assert.ok(inputA); assert.ok(inputB);
  inputA.value = '保留文件草稿'; inputB.value = '保留分析草稿';
  // JSDOM不负责Enter/Space的浏览器原生激活，直接点击真实button验证其切换处理。
  await act(async () => { a.button.click(); });
  assert.equal(a.button.getAttribute('aria-expanded'), 'true');
  assert.equal(a.description.hidden, false);
  assert.equal(b.button.getAttribute('aria-expanded'), 'false');
  assert.equal(b.description.hidden, true);
  await act(async () => { b.button.click(); a.button.click(); });
  assert.equal(a.button.getAttribute('aria-expanded'), 'false');
  assert.equal(a.description.hidden, true);
  assert.equal(b.button.getAttribute('aria-expanded'), 'true');
  assert.equal(b.description.hidden, false);
  assert.equal(first.root.querySelector('input'), inputA);
  assert.equal(second.root.querySelector('input'), inputB);
  assert.equal(inputA.value, '保留文件草稿');
  assert.equal(inputB.value, '保留分析草稿');
  await first.close();
  assert.equal(first.root.childElementCount, 0);
  assert.equal(f.browser.window.document.getElementById(a.descriptionId), null);
  assert.equal(second.root.querySelector('input'), inputB);
  assert.equal(inputB.value, '保留分析草稿');
  assert.equal(b.description.hidden, false);
  await act(async () => { b.button.click(); });
  assert.equal(b.button.getAttribute('aria-expanded'), 'false');
  assert.equal(b.description.hidden, true);
});

test('没有说明的标题不显示披露入口，原子动作和输入保持可用', async (unit) => {
  const f = await fixture(unit);
  let refreshes = 0;
  const current = await f.mount(createElement(f.PageTitle, { title: '任务',
    children: createElement('div', null,
      createElement('input', { 'aria-label': '任务草稿', defaultValue: '继续保留' }),
      createElement('button', { type: 'button', onClick: () => { refreshes++; } }, '刷新任务')) }));
  assert.equal(current.root.querySelector('h1')?.textContent, '任务');
  assert.equal(current.root.querySelector('.page-help'), null);
  assert.equal(current.root.querySelector('[aria-expanded], [aria-controls]'), null);
  const input = current.root.querySelector<HTMLInputElement>('input'); assert.ok(input);
  input.value = '未提交的任务草稿';
  const action = current.root.querySelector<HTMLButtonElement>('button'); assert.ok(action);
  await act(async () => { action.click(); });
  assert.equal(refreshes, 1);
  assert.equal(current.root.querySelector('input'), input);
  assert.equal(input.value, '未提交的任务草稿');
});
