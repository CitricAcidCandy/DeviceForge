import test from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
const { useAction } = await import('../src/view-support.tsx');
const { SettingsWaitFailure } = await import('../src/model/index.ts');

test('取消等待仍展示原已接受任务回执，后续独立成功不受旧结果污染', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousAct = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  let fail: (error: unknown) => void = () => undefined;
  let seen: ReturnType<typeof useAction> | null = null;
  function Harness() {
    const action = useAction(); seen = action;
    return createElement('p', {}, action.error instanceof Error ? action.error.message : action.result ? '成功' : '等待');
  }
  const target = dom.window.document.getElementById('root');
  assert.ok(target);
  const root = createRoot(target);
  try {
    await act(async () => { root.render(createElement(Harness)); });
    const current = () => { assert.ok(seen); return seen; };
    await act(async () => {
      void current().run(() => new Promise((_resolve, reject) => { fail = reject; }));
    });
    await act(async () => {
      current().cancel();
      fail(new SettingsWaitFailure({
        id: 'original-task', operation: 'plugin.settings.set', status: 'running', error: null, result: null,
      }, 'log-submit', null, new Error('原任务结果未确认'), 'log-query'));
    });
    assert.match(target.textContent ?? '', /原任务结果未确认/);
    assert.equal(current().logId, 'log-query');
    await act(async () => { await current().run(async () => ({ value: true })); });
    assert.equal(target.textContent, '成功');
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else Reflect.deleteProperty(globalThis, 'document');
    if (previousAct) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previousAct); else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  }
});
