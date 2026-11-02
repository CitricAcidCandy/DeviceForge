import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, useLayoutEffect } from 'react';
import { JSDOM } from 'jsdom';
import type { Dispose } from '../src/plugin-sdk/index.ts';
import type { HostUiHolder } from '../src/app/public-ui.ts';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';

const imports = registerCompositionStartupImports();
assert.deepEqual(imports.diagnostics, []);
const { installPublicUi } = await import('../src/app/public-ui.ts');
imports.dispose();

for (const phase of ['render', 'layout', 'unknown'] as const) {
  test(`共享React首次${phase}失败明确拒绝挂载，回收根后独立新调用仍可显示`, async () => {
    const browser = new JSDOM('<!doctype html><html><body><div id="root"></div><p id="unrelated">保留</p></body></html>');
    const document = browser.window.document, root = document.getElementById('root');
    assert.ok(root);
    const previous = new Map<string, PropertyDescriptor | undefined>();
    const reported: unknown[] = [];
    for (const [name, value] of Object.entries({
      window: browser.window, document, navigator: browser.window.navigator,
      HTMLElement: browser.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: false,
      reportError: (error: unknown) => { reported.push(error); },
    })) {
      previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    const holder: HostUiHolder = {};
    const uninstall = installPublicUi(holder);
    const ui = holder.__DEVICEFORGE_HOST_UI__;
    assert.ok(ui);
    const releases: Dispose[] = [];
    const originalError = phase === 'unknown' ? null : new Error(`首次${phase}故障`);
    function BrokenView() {
      useLayoutEffect(() => { if (phase === 'layout') throw originalError; }, []);
      if (phase !== 'layout') throw originalError;
      return createElement('input', { 'aria-label': '未完成的初始视图' });
    }
    try {
      assert.throws(() => {
        releases.push(ui.mountReact(root, createElement(BrokenView)));
      }, (failure: unknown) => failure === originalError, '不能把首次React错误当成挂载成功');
      assert.equal(root.childElementCount, 0, '失败根不能残留部分提交内容');
      assert.equal(document.getElementById('unrelated')?.textContent, '保留');
      const release = ui.mountReact(root, createElement('input', { 'aria-label': '独立新视图' }));
      releases.push(release);
      assert.ok(root.querySelector('input[aria-label="独立新视图"]'));
      await release();
      await release();
      assert.equal(root.childElementCount, 0);
      assert.deepEqual(reported, [], '已向调用方返回的首次故障不能再冒充全局未处理错误');
    } finally {
      for (const release of releases.reverse()) await release();
      await uninstall();
      // 让React已排入队列的收尾在DOM仍存在时完成，不把它留给后续测试。
      await new Promise<void>((resolve) => setImmediate(resolve));
      browser.window.close();
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });
}
