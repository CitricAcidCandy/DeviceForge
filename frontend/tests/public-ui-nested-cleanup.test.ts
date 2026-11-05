import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { act, createElement, Fragment, useEffect, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { JSDOM } from 'jsdom';
import type { Dispose } from '../src/plugin-sdk/index.ts';
import type { HostUiHolder } from '../src/app/public-ui.ts';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';

async function fixture(unit: TestContext) {
  const parser = registerCompositionStartupImports();
  assert.deepEqual(parser.diagnostics, []);
  const browser = new JSDOM('<!doctype html><html><body><main id="parent"></main><p id="other">保留</p></body></html>');
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const errors: unknown[][] = [], reported: unknown[] = [];
  for (const [name, value] of Object.entries({
    window: browser.window, document: browser.window.document, navigator: browser.window.navigator,
    HTMLElement: browser.window.HTMLElement, Element: browser.window.Element, Node: browser.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  browser.window.reportError = (error: unknown) => { reported.push(error); };
  unit.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
  unit.mock.method(globalThis, 'fetch', async () => { throw new Error('此共享根单元不允许联网'); });
  const { installPublicUi } = await import('../src/app/public-ui.ts');
  const holder: HostUiHolder = {}, releaseUi = installPublicUi(holder);
  const ui = holder.__DEVICEFORGE_HOST_UI__; assert.ok(ui);
  const usePortalContentRef = ui.usePortalContentRef; assert.ok(usePortalContentRef);
  const root = browser.window.document.getElementById('parent'); assert.ok(root);
  const parent = createRoot(root);
  let parentClosed = false;
  const releases: Dispose[] = [];
  async function closeParent() {
    if (parentClosed) return;
    parentClosed = true;
    await act(async () => { parent.unmount(); });
  }
  unit.after(async () => {
    try {
      await closeParent();
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
  return { browser, ui, usePortalContentRef, root, parent, closeParent, releases, errors, reported };
}

for (const phase of ['layout', 'effect'] as const) {
  test(`父根 ${phase} 清理可等待共享子根释放，无跨树同步卸载警告且 Portal 与 DOM 撤销`, async (unit) => {
    const f = await fixture(unit);
    let childRelease: Dispose = () => {};
    let portal: HTMLDivElement | null = null;
    let childCleanups = 0, synchronousRevocation = false;
    const receipts: ReturnType<Dispose>[] = [];
    function Parent() {
      const useCleanup = phase === 'layout' ? useLayoutEffect : useEffect;
      useCleanup(() => () => {
        receipts.push(childRelease(), childRelease());
        synchronousRevocation = portal !== null && !portal.hasAttribute('data-deviceforge-portal');
      }, []);
      return createElement('section', {
        'data-deviceforge-plugin': 'nested_cleanup', 'data-deviceforge-generation': '1',
        'data-deviceforge-extension': 'nested_cleanup.child',
      }, createElement('div', { 'data-unit-child-root': phase }));
    }
    function Child() {
      const ownedRef = f.usePortalContentRef<HTMLDivElement>((element) => { portal = element; });
      useLayoutEffect(() => () => { childCleanups++; }, []);
      return createElement(Fragment, null, createElement('input', { defaultValue: '保留到释放' }),
        createPortal(createElement('div', { ref: ownedRef, 'data-unit-portal': phase }, '子根弹层'), f.browser.window.document.body));
    }
    await act(async () => { f.parent.render(createElement(Parent)); });
    const target = f.root.querySelector<HTMLElement>('[data-unit-child-root]'); assert.ok(target);
    await act(async () => { childRelease = f.ui.mountReact(target, createElement(Child)); });
    f.releases.push(childRelease);
    assert.equal(target.childElementCount, 1, '共享根首次挂载必须同步完成');
    const owned = f.browser.window.document.querySelector('[data-unit-portal]'); assert.ok(owned);
    assert.equal(owned.hasAttribute('data-deviceforge-portal'), true);
    await f.closeParent();
    for (const receipt of receipts) await receipt;
    const warnings = f.errors.flatMap((args) => args.filter((value): value is string => typeof value === 'string'))
      .filter((value) => /synchronously unmount|flushSync was called from inside a lifecycle/iu.test(value));
    assert.equal(warnings.length, 0, warnings.join('\n'));
    const first = receipts[0]; assert.ok(first instanceof Promise, '释放必须返回可等待的 Promise');
    assert.equal(receipts[1] === first, true, '重复释放必须返回同一结果');
    assert.equal(synchronousRevocation, true, '所属 Portal 身份须立即撤销');
    assert.equal(childCleanups, 1);
    assert.equal(target.childElementCount, 0);
    assert.equal(f.browser.window.document.querySelector('[data-unit-portal]'), null);
    assert.equal(f.browser.window.document.getElementById('other')?.textContent, '保留');
    assert.equal(f.reported.length, 0);
  });
}

test('共享根卸载真实错误由同一释放 Promise 返回，独立新根仍能同步挂载', async (unit) => {
  const f = await fixture(unit), failure = new Error('子根布局清理真实失败');
  const target = f.browser.window.document.createElement('div');
  f.browser.window.document.body.append(target);
  let cleanups = 0, release: Dispose = () => {};
  function BrokenCleanup() {
    useLayoutEffect(() => () => { cleanups++; throw failure; }, []);
    return createElement('input', { 'aria-label': '故障前的子根' });
  }
  await act(async () => { release = f.ui.mountReact(target, createElement(BrokenCleanup)); });
  const receipts: ReturnType<Dispose>[] = [];
  // 此处读取公开释放回执，不让act另行接管同一React错误。
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: false });
  try {
    receipts.push(release(), release());
    await assert.rejects(Promise.resolve(receipts[0]), (error: unknown) => error === failure);
  } finally {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });
  }
  assert.ok(receipts[0] instanceof Promise);
  assert.equal(receipts[0] === receipts[1], true);
  assert.equal(cleanups, 1);
  assert.equal(target.childElementCount, 0);
  assert.equal(f.reported.length, 0, '已返回释放调用方的错误不能再次当作未处理异常');
  await act(async () => {
    const current = f.ui.mountReact(target, createElement('input', { 'aria-label': '独立新调用' }));
    f.releases.push(current);
    assert.ok(target.querySelector('input[aria-label="独立新调用"]'));
  });
});
