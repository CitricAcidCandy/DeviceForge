import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { copyText } from '../src/shared/clipboard/index.ts';

async function withClipboard(run: (documentRef: Document, navigatorRef: Navigator) => Promise<void>) {
  const browser = new JSDOM('<!doctype html><body><textarea id="draft">原有输入内容</textarea><p id="text">原有页面选择内容</p></body>', {
    url: 'http://192.168.50.5/', pretendToBeVisual: true,
  });
  const descriptors = new Map(['document', 'navigator'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.window.document });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.window.navigator });
  try {
    await run(browser.window.document, browser.window.navigator);
  } finally {
    browser.window.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

function legacyCopy(documentRef: Document, result: boolean | Error, copied: string[]) {
  Object.defineProperty(documentRef, 'execCommand', { configurable: true, value(command: string) {
    assert.equal(command, 'copy');
    const temporary = documentRef.querySelector('textarea[aria-hidden="true"]');
    const view = documentRef.defaultView;
    assert.ok(view);
    assert.ok(temporary instanceof view.HTMLTextAreaElement);
    assert.equal(documentRef.activeElement, temporary);
    assert.equal(temporary.readOnly, true);
    assert.equal(temporary.selectionStart, 0);
    assert.equal(temporary.selectionEnd, temporary.value.length);
    assert.ok(temporary.classList.contains('opacity-0'));
    copied.push(temporary.value);
    if (result instanceof Error) throw result;
    return result;
  } });
}

test('原生剪贴板成功不创建临时输入或调用兼容命令', async () => {
  await withClipboard(async (documentRef, navigatorRef) => {
    let copied = '';
    const clipboard = { async writeText(value: string) { assert.equal(this, clipboard); copied = value; } };
    Object.defineProperty(navigatorRef, 'clipboard', { configurable: true, value: clipboard });
    Object.defineProperty(documentRef, 'execCommand', { configurable: true, value() {
      assert.fail('原生成功后不应调用兼容复制');
    } });
    assert.equal(await copyText('native-log'), true);
    assert.equal(copied, 'native-log');
    assert.equal(documentRef.querySelector('textarea[aria-hidden="true"]'), null);
  });
});

test('局域网HTTP没有clipboard时使用临时textarea，恢复输入焦点与反向选择', async () => {
  await withClipboard(async (documentRef, navigatorRef) => {
    Object.defineProperty(navigatorRef, 'clipboard', { configurable: true, value: undefined });
    const draft = documentRef.querySelector('textarea');
    assert.ok(draft);
    draft.focus();
    draft.setSelectionRange(1, 4, 'backward');
    const copied: string[] = [];
    legacyCopy(documentRef, true, copied);
    assert.equal(await copyText('lan-log'), true);
    assert.deepEqual(copied, ['lan-log']);
    assert.equal(documentRef.activeElement, draft);
    assert.equal(draft.value, '原有输入内容');
    assert.equal(draft.selectionStart, 1);
    assert.equal(draft.selectionEnd, 4);
    assert.equal(draft.selectionDirection, 'backward');
    assert.equal(documentRef.querySelectorAll('textarea').length, 1);
  });
});

test('原生接口拒绝或同步抛错时继续兼容复制', async () => {
  for (const writeText of [
    async () => { throw new Error('权限拒绝'); },
    () => { throw new Error('同步拒绝'); },
  ]) await withClipboard(async (documentRef, navigatorRef) => {
    Object.defineProperty(navigatorRef, 'clipboard', { configurable: true, value: { writeText } });
    const copied: string[] = [];
    legacyCopy(documentRef, true, copied);
    assert.equal(await copyText('fallback-log'), true);
    assert.deepEqual(copied, ['fallback-log']);
    assert.equal(documentRef.querySelector('textarea[aria-hidden="true"]'), null);
  });
});

test('兼容命令返回false或抛错时明确失败，并清理临时节点恢复焦点和选择', async () => {
  for (const result of [false, new Error('复制被拒绝')]) await withClipboard(async (documentRef, navigatorRef) => {
    Object.defineProperty(navigatorRef, 'clipboard', { configurable: true, value: undefined });
    const draft = documentRef.querySelector('textarea');
    assert.ok(draft);
    draft.focus();
    draft.setSelectionRange(2, 5, 'forward');
    const copied: string[] = [];
    legacyCopy(documentRef, result, copied);
    assert.equal(await copyText('failed-log'), false);
    assert.deepEqual(copied, ['failed-log']);
    assert.equal(documentRef.activeElement, draft);
    assert.equal(draft.selectionStart, 2);
    assert.equal(draft.selectionEnd, 5);
    assert.equal(draft.selectionDirection, 'forward');
    assert.equal(documentRef.querySelectorAll('textarea').length, 1);
  });
});

test('兼容复制成功或失败都恢复页面原有的反向文字选择及焦点', async () => {
  for (const result of [true, false]) await withClipboard(async (documentRef, navigatorRef) => {
    Object.defineProperty(navigatorRef, 'clipboard', { configurable: true, value: undefined });
    const paragraph = documentRef.querySelector('p');
    assert.ok(paragraph);
    paragraph.tabIndex = 0;
    paragraph.focus();
    const text = paragraph.firstChild;
    assert.ok(text);
    const selection = documentRef.getSelection();
    assert.ok(selection);
    selection.setBaseAndExtent(text, 6, text, 1);
    const copied: string[] = [];
    legacyCopy(documentRef, result, copied);
    assert.equal(await copyText('selected-log'), result);
    assert.equal(documentRef.activeElement, paragraph);
    assert.equal(selection.anchorNode, text);
    assert.equal(selection.anchorOffset, 6);
    assert.equal(selection.focusNode, text);
    assert.equal(selection.focusOffset, 1);
    assert.equal(documentRef.querySelector('textarea[aria-hidden="true"]'), null);
  });
});

test('复制期间用户转移焦点后，原生拒绝的兼容流程保留用户新选择', async () => {
  await withClipboard(async (documentRef, navigatorRef) => {
    let rejectNative: ((reason: Error) => void) | undefined;
    Object.defineProperty(navigatorRef, 'clipboard', { configurable: true, value: {
      writeText() { return new Promise<void>((_resolve, reject) => { rejectNative = reject; }); },
    } });
    legacyCopy(documentRef, true, []);
    const pending = copyText('late-fallback-log');
    const draft = documentRef.querySelector('textarea');
    assert.ok(draft);
    draft.focus();
    draft.setSelectionRange(1, 3, 'backward');
    assert.ok(rejectNative);
    rejectNative(new Error('延迟拒绝'));
    assert.equal(await pending, true);
    assert.equal(documentRef.activeElement, draft);
    assert.equal(draft.selectionStart, 1);
    assert.equal(draft.selectionEnd, 3);
    assert.equal(draft.selectionDirection, 'backward');
  });
});

test('没有任何复制接口或读取clipboard抛错时返回失败，不遗留临时节点', async () => {
  await withClipboard(async (documentRef, navigatorRef) => {
    Object.defineProperty(navigatorRef, 'clipboard', { configurable: true, get() { throw new Error('不可访问'); } });
    assert.equal(await copyText('unavailable-log'), false);
    assert.equal(documentRef.querySelector('textarea[aria-hidden="true"]'), null);
  });
});

test('空白文本不调用剪贴板，避免复制不存在的日志ID', async () => {
  await withClipboard(async (documentRef, navigatorRef) => {
    Object.defineProperty(navigatorRef, 'clipboard', { configurable: true, value: {
      async writeText() { assert.fail('空白文本不能复制'); },
    } });
    assert.equal(await copyText('   '), false);
    assert.equal(documentRef.querySelector('textarea[aria-hidden="true"]'), null);
  });
});
