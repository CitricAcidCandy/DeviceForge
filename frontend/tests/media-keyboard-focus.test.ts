import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import { useMediaKeyboard } from '../src/pages/devices/screen/use-media-keyboard.ts';
import type { MirroringControl } from '../src/features/mirroring-streaming/index.ts';

test('画面焦点隔离键盘，失焦与后台释放，换代和关闭不重放按键', async () => {
  const browser = new JSDOM('<!doctype html><div id="keyboard-test"></div>', {
    url: 'http://localhost:5173', pretendToBeVisual: true,
  });
  const windowRef = browser.window;
  const globals: Readonly<Record<string, unknown>> = {
    window: windowRef, document: windowRef.document, navigator: windowRef.navigator,
    HTMLElement: windowRef.HTMLElement, HTMLInputElement: windowRef.HTMLInputElement,
    Node: windowRef.Node, IS_REACT_ACT_ENVIRONMENT: true,
  };
  const descriptors = new Map(Object.keys(globals).map((name) =>
    [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries(globals))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  const target = windowRef.document.getElementById('keyboard-test');
  assert.ok(target);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(target);
  const received: MirroringControl[] = [];
  let active = true;
  let ready = true;
  let identity = 'first:1';
  let surface: 'canvas' | 'video' = 'video';
  function Harness() {
    const keyboard = useMediaKeyboard({
      active, ready, identity, enqueue: (values) => received.push(...values),
    });
    return createElement('div', null,
      createElement(surface, {
        'data-focused': keyboard.focused,
        tabIndex: keyboard.tabIndex,
        onFocus: keyboard.onFocus, onBlur: keyboard.onBlur,
        onKeyDown: keyboard.onKeyDown, onKeyUp: keyboard.onKeyUp,
      }),
      createElement('input', { 'aria-label': '正常文本输入' }),
    );
  }
  const render = () => act(async () => root.render(createElement(Harness)));
  const screen = () => {
    const element = target.querySelector(surface);
    assert.ok(element);
    return element;
  };
  const key = async (element: Element, type: 'keydown' | 'keyup', code = 'KeyW', value = 'w') => {
    const event = new windowRef.KeyboardEvent(type, { code, key: value, bubbles: true, cancelable: true });
    await act(async () => { element.dispatchEvent(event); });
    return event;
  };
  const ups = () => received.filter((value) => value.type === 'key' && value.action === 'up').length;
  try {
    await render();
    const input = target.querySelector('input');
    assert.ok(input);
    await act(async () => input.focus());
    assert.equal((await key(input, 'keydown')).defaultPrevented, false);
    assert.equal(received.length, 0);
    await act(async () => screen().focus());
    assert.equal(screen().getAttribute('data-focused'), 'true');
    assert.equal((await key(screen(), 'keydown')).defaultPrevented, true);
    assert.equal(received.length, 1);
    await act(async () => input.focus());
    assert.equal(ups(), 1);
    assert.equal(screen().getAttribute('data-focused'), 'false');
    await act(async () => screen().focus());
    await key(screen(), 'keydown', 'Space', ' ');
    await act(async () => windowRef.dispatchEvent(new windowRef.Event('blur')));
    assert.equal(ups(), 2);
    await key(screen(), 'keyup', 'Space', ' ');
    assert.equal(ups(), 2);
    await key(screen(), 'keydown');
    Object.defineProperty(windowRef.document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => windowRef.document.dispatchEvent(new windowRef.Event('visibilitychange')));
    assert.equal(ups(), 3);
    Object.defineProperty(windowRef.document, 'visibilityState', { configurable: true, value: 'visible' });
    await key(screen(), 'keydown');
    identity = 'second:2';
    await render();
    await key(screen(), 'keyup');
    assert.equal(ups(), 3);
    await key(screen(), 'keydown');
    ready = false;
    await render();
    assert.equal(ups(), 4);
    assert.equal(screen().tabIndex, -1);
    assert.equal((await key(screen(), 'keydown')).defaultPrevented, false);
    ready = true;
    surface = 'canvas';
    await render();
    await act(async () => screen().focus());
    assert.equal((await key(screen(), 'keydown', 'ArrowDown', 'ArrowDown')).defaultPrevented, true);
    await key(screen(), 'keyup', 'ArrowDown', 'ArrowDown');
    assert.equal(ups(), 5);
    active = false;
    await render();
    assert.equal(screen().tabIndex, -1);
    const beforeClosed = received.length;
    assert.equal((await key(screen(), 'keydown')).defaultPrevented, false);
    await act(async () => windowRef.dispatchEvent(new windowRef.Event('blur')));
    assert.equal(received.length, beforeClosed);
  } finally {
    await act(async () => root.unmount());
    browser.window.close();
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
