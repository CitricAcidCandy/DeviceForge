import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import type { Dispose } from '../src/plugin-sdk/index.ts';
import { createFileBrowser } from '../plugins/files/src/model/index.ts';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';

const page = new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>', {
  url: 'http://127.0.0.1:7031/#/files', pretendToBeVisual: true,
});
const document = page.window.document;
const saved = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: page.window, document, navigator: page.window.navigator,
  HTMLElement: page.window.HTMLElement, Element: page.window.Element, Node: page.window.Node,
  HTMLInputElement: page.window.HTMLInputElement, HTMLButtonElement: page.window.HTMLButtonElement,
  HTMLSelectElement: page.window.HTMLSelectElement, HTMLFormElement: page.window.HTMLFormElement,
  DocumentFragment: page.window.DocumentFragment, NodeFilter: page.window.NodeFilter,
  MutationObserver: page.window.MutationObserver, CustomEvent: page.window.CustomEvent,
  getComputedStyle: page.window.getComputedStyle.bind(page.window),
  requestAnimationFrame: page.window.requestAnimationFrame.bind(page.window),
  cancelAnimationFrame: page.window.cancelAnimationFrame.bind(page.window), IS_REACT_ACT_ENVIRONMENT: true,
})) {
  saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
const imports = registerCompositionStartupImports();
const { installPublicUi } = await import('../src/app/public-ui.ts');
const { hostUi } = await import('../src/plugin-sdk/index.ts');
const { FilesView } = await import('../plugins/files/src/view.tsx');
const releaseUi = installPublicUi();
after(async () => {
  await act(async () => {});
  await new Promise<void>((resolve) => setImmediate(resolve));
  await releaseUi(); imports.dispose(); page.window.close();
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  }
});

test('原文件输入与ZIP分页经公开挂载保留，使用说明披露不重建文件草稿或模型', async () => {
  const id = '12345678-1234-1234-1234-123456789abc';
  const calls: { readonly kind: string; readonly id: string; readonly offset?: number; readonly limit?: number }[] = [];
  const browser = createFileBrowser({
    metadata: async (artifactId) => {
      calls.push({ kind: 'metadata', id: artifactId });
      return { data: { id: artifactId, filename: '原目录.zip', mediaType: 'application/zip',
        size: 512, sha256: 'a'.repeat(64), createdAt: 1000 }, logId: 'metadata-log' };
    },
    entries: async (artifactId, query) => {
      assert.equal(query.limit, 2);
      assert.ok(query.offset === 0 || query.offset === 2);
      calls.push({ kind: 'entries', id: artifactId, offset: query.offset, limit: query.limit });
      const entries = ['first.txt', 'second.txt', 'last.txt'].slice(query.offset, query.offset + query.limit)
        .map((name) => ({ name, directory: false, size: 10, compressedSize: 5 }));
      return { data: { entries, total: 3, nextOffset: query.offset === 0 ? 2 : null }, logId: 'entries-log' };
    },
    remove: async () => { throw new Error('文件页还原单元不得删除产物'); },
    download: async () => { throw new Error('文件页还原单元不得下载产物'); },
    upload: async () => { throw new Error('文件页还原单元不得上传真实文件'); },
  });
  const target = document.getElementById('root'); assert.ok(target);
  let release: Dispose = () => {};
  const input = (label: string) => {
    const named = [...target.querySelectorAll('label')].find((element) => element.textContent === label);
    assert.ok(named, `缺少原字段：${label}`);
    const control = document.getElementById(named.htmlFor);
    assert.ok(control instanceof page.window.HTMLInputElement);
    return control;
  };
  const button = (label: string) => {
    const control = [...target.querySelectorAll<HTMLButtonElement>('button')].find((element) =>
      (element.getAttribute('aria-label') ?? element.textContent?.trim()) === label);
    assert.ok(control, `缺少原操作：${label}`); return control;
  };
  const fill = async (control: HTMLInputElement, value: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(page.window.HTMLInputElement.prototype, 'value')?.set;
      assert.ok(setter); setter.call(control, value);
      control.dispatchEvent(new page.window.Event('input', { bubbles: true }));
    });
  };
  try {
    await act(async () => { release = hostUi().mountReact(target, createElement(FilesView, { browser, documentRef: document })); });
    assert.deepEqual(calls, [], '初始显示不自动读取服务器产物');
    const root = target.querySelector('[aria-label="文件与产物"]'); assert.ok(root);
    const idInput = input('产物 ID');
    await fill(idInput, id);
    await act(async () => { button('打开文件').click(); });
    assert.deepEqual(calls, [{ kind: 'metadata', id }]);
    assert.equal(target.querySelector('h2')?.textContent, '原目录.zip');
    const limitInput = input('每页条目');
    await fill(limitInput, '2');
    await act(async () => { button('读取目录').click(); });
    assert.match(target.querySelector('table')?.textContent ?? '', /first\.txt/);
    assert.match(target.querySelector('table')?.textContent ?? '', /second\.txt/);
    assert.doesNotMatch(target.querySelector('table')?.textContent ?? '', /last\.txt/);

    const snapshot = browser.snapshot(), disclosure = button('使用说明');
    assert.equal(disclosure.getAttribute('aria-expanded'), 'false');
    const controlledId = disclosure.getAttribute('aria-controls'); assert.ok(controlledId);
    await act(async () => { disclosure.click(); });
    assert.equal(disclosure.getAttribute('aria-expanded'), 'true');
    const help = document.getElementById(controlledId); assert.ok(help);
    assert.equal(help.hidden, false);
    assert.equal(target.querySelector('[aria-label="文件与产物"]'), root);
    assert.equal(input('产物 ID'), idInput); assert.equal(input('每页条目'), limitInput);
    assert.equal(idInput.value, id); assert.equal(limitInput.value, '2');
    assert.equal(browser.snapshot(), snapshot);
    await act(async () => { disclosure.click(); });
    assert.equal(disclosure.getAttribute('aria-expanded'), 'false');
    assert.equal(input('产物 ID'), idInput); assert.equal(input('每页条目'), limitInput);
    assert.equal(browser.snapshot(), snapshot, '说明披露不清空或重读当前目录页');

    await act(async () => { button('下一页').click(); });
    assert.match(target.querySelector('table')?.textContent ?? '', /last\.txt/);
    assert.doesNotMatch(target.querySelector('table')?.textContent ?? '', /first\.txt|second\.txt/);
    assert.equal(button('下一页').disabled, true);
    assert.deepEqual(calls, [{ kind: 'metadata', id },
      { kind: 'entries', id, offset: 0, limit: 2 }, { kind: 'entries', id, offset: 2, limit: 2 }]);
  } finally { await act(async () => { await release(); browser.dispose(); }); }
});
