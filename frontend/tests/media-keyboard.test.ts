import assert from 'node:assert/strict';
import test from 'node:test';
import type { MirroringControl } from '../src/features/mirroring-streaming/index.ts';
import { createMediaKeyboardControl, type MediaKeyboardEvent } from '../src/pages/media/media-keyboard.ts';

function event(code: string, options: Partial<MediaKeyboardEvent> & { readonly modifiers?: readonly string[] } = {}): MediaKeyboardEvent {
  const modifiers = new Set(options.modifiers ?? []);
  return {
    code,
    key: options.key ?? code,
    repeat: options.repeat ?? false,
    ctrlKey: options.ctrlKey ?? modifiers.has('Control'),
    altKey: options.altKey ?? modifiers.has('Alt'),
    shiftKey: options.shiftKey ?? modifiers.has('Shift'),
    metaKey: options.metaKey ?? modifiers.has('Meta'),
    isComposing: options.isComposing ?? false,
    ...(options.keyCode === undefined ? {} : { keyCode: options.keyCode }),
    getModifierState: (name) => modifiers.has(name),
  };
}

test('键盘按键映射、长按重复次数和释放顺序保持 Android 控制协议', () => {
  const sent: MirroringControl[][] = [];
  const keyboard = createMediaKeyboardControl({ ready: () => true, identity: () => 'session:1', enqueue: (values) => sent.push([...values]) });
  assert.equal(keyboard.keyDown(event('ShiftLeft', { modifiers: ['Shift'] })), true);
  assert.equal(keyboard.keyDown(event('KeyD', { modifiers: ['Shift'] })), true);
  assert.equal(keyboard.keyDown(event('KeyD', { modifiers: ['Shift'], repeat: true })), true);
  assert.equal(keyboard.keyUp(event('KeyD', { modifiers: ['Shift'] })), true);
  keyboard.release();
  assert.deepEqual(sent.map((batch) => batch.map((value) => value.type === 'key' ? {
    action: value.action, keycode: value.keycode, repeat: value.repeat, meta_state: value.meta_state,
  } : value)), [
    [{ action: 'down', keycode: 59, repeat: 0, meta_state: 1 | 0x40 }],
    [{ action: 'down', keycode: 32, repeat: 0, meta_state: 1 | 0x40 }],
    [{ action: 'down', keycode: 32, repeat: 1, meta_state: 1 | 0x40 }],
    [{ action: 'up', keycode: 32, repeat: undefined, meta_state: 1 | 0x40 }],
    [{ action: 'up', keycode: 59, repeat: undefined, meta_state: 0 }],
  ]);
});

test('组合输入和浏览器快捷键不劫持，失焦释放不依赖 ready', () => {
  const sent: MirroringControl[][] = [];
  let available = true;
  let identity = 'session:1';
  const keyboard = createMediaKeyboardControl({ ready: () => available, identity: () => identity, enqueue: (values) => sent.push([...values]) });
  assert.equal(keyboard.keyDown(event('KeyA', { isComposing: true })), false);
  assert.equal(keyboard.keyDown(event('KeyL', { ctrlKey: true, modifiers: ['Control'] })), false);
  assert.equal(sent.length, 0);
  assert.equal(keyboard.keyDown(event('KeyA')), true);
  available = false;
  keyboard.release();
  assert.equal(sent.at(-1)?.[0]?.type, 'key');
  identity = 'session:2';
  assert.equal(keyboard.keyUp(event('KeyA')), false);
  assert.equal(sent.length, 2);
});

test('Ctrl+C、Ctrl+X、Ctrl+V 交给剪贴板适配器', () => {
  const actions: string[] = [];
  const keyboard = createMediaKeyboardControl({
    ready: () => true,
    identity: () => 'session:clipboard',
    enqueue: () => {},
    clipboardShortcut: (action) => { actions.push(action); return true; },
  });
  assert.equal(keyboard.keyDown(event('KeyC', { ctrlKey: true })), true);
  assert.equal(keyboard.keyDown(event('KeyX', { ctrlKey: true })), true);
  assert.equal(keyboard.keyDown(event('KeyV', { ctrlKey: true })), true);
  assert.deepEqual(actions, ['copy', 'cut', 'paste']);
});

test('按键映射覆盖常用数字、标点、方向、空格和返回键', () => {
  const sent: MirroringControl[] = [];
  const keyboard = createMediaKeyboardControl({ ready: () => true, identity: () => 'session:1', enqueue: (values) => sent.push(...values) });
  for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Digit0', 'Digit1', 'Space', 'Enter', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Comma', 'Period', 'Slash', 'Escape']) {
    keyboard.keyDown(event(code));
    keyboard.keyUp(event(code));
  }
  assert.deepEqual(sent.filter((value): value is Extract<MirroringControl, { type: 'key' }> => value.type === 'key' && value.action === 'down').map((value) => value.keycode), [51, 29, 47, 32, 7, 8, 62, 66, 67, 19, 20, 21, 22, 55, 56, 76, 4]);
});

test('失焦按逆序释放并根据剩余修饰键重算状态', () => {
  const sent: MirroringControl[][] = [];
  const keyboard = createMediaKeyboardControl({ ready: () => true, identity: () => 'session:1', enqueue: (values) => sent.push([...values]) });
  keyboard.keyDown(event('ShiftLeft', { shiftKey: true }));
  keyboard.keyDown(event('KeyD', { shiftKey: true }));
  keyboard.release();
  assert.deepEqual(sent.at(-1), [
    { type: 'key', action: 'up', keycode: 32, meta_state: 1 | 0x40 },
    { type: 'key', action: 'up', keycode: 59, meta_state: 0 },
  ]);
  keyboard.keyDown(event('ShiftLeft', { shiftKey: true }));
  keyboard.keyDown(event('ControlLeft', { shiftKey: true, ctrlKey: true }));
  keyboard.keyUp(event('ShiftLeft', { ctrlKey: true }));
  keyboard.release();
  assert.deepEqual(sent.at(-1), [{ type: 'key', action: 'up', keycode: 113, meta_state: 0 }]);
});

test('浏览器快捷键与 Tab 焦点导航放行并解除已有按键', () => {
  const sent: MirroringControl[][] = [];
  const keyboard = createMediaKeyboardControl({ ready: () => true, identity: () => 'session:1', enqueue: (values) => sent.push([...values]) });
  for (const code of ['KeyA', 'KeyB', 'KeyC', 'KeyD', 'KeyE', 'KeyG', 'KeyH', 'KeyJ', 'KeyU', 'KeyV', 'KeyX', 'KeyF', 'KeyZ', 'KeyY', 'KeyS', 'KeyP', 'KeyO', 'KeyL', 'KeyT', 'KeyW', 'KeyR', 'KeyN', 'Digit1', 'Digit0', 'Minus', 'Equal']) {
    keyboard.keyDown(event('KeyD'));
    assert.equal(keyboard.keyDown(event(code, { ctrlKey: true })), false);
    assert.deepEqual(sent.at(-1), [{ type: 'key', action: 'up', keycode: 32, meta_state: 0 }]);
    assert.equal(keyboard.keyDown(event(code, { metaKey: true })), false);
  }
  for (const shortcut of [event('Tab'), event('Tab', { shiftKey: true }), event('Tab', { altKey: true }), event('F4', { altKey: true }), event('ArrowLeft', { altKey: true }), event('ArrowRight', { altKey: true }), event('KeyD', { altKey: true }), event('Home', { altKey: true }), event('F5'), event('F11')]) {
    keyboard.keyDown(event('KeyD'));
    assert.equal(keyboard.keyDown(shortcut), false);
    assert.deepEqual(sent.at(-1), [{ type: 'key', action: 'up', keycode: 32, meta_state: 0 }]);
  }
});

test('代次改变、孤立长按和 reset 不向新会话补发旧按键', () => {
  const sent: MirroringControl[][] = [];
  let identity = 'session:1';
  const keyboard = createMediaKeyboardControl({ ready: () => true, identity: () => identity, enqueue: (values) => sent.push([...values]) });
  keyboard.keyDown(event('KeyW'));
  identity = 'session:2';
  keyboard.release();
  assert.equal(keyboard.keyUp(event('KeyW')), false);
  assert.equal(keyboard.keyDown(event('KeyW', { repeat: true })), false);
  assert.equal(sent.length, 1);
  assert.equal(keyboard.keyDown(event('KeyW')), true);
  keyboard.reset();
  assert.equal(keyboard.keyUp(event('KeyW')), false);
  assert.equal(keyboard.keyDown(event('KeyW', { repeat: true })), false);
  keyboard.keyDown(event('KeyW'));
  keyboard.release();
  assert.equal(keyboard.keyDown(event('KeyW', { repeat: true })), false);
});

test('长按计数有界，松键使用原始映射，组合及死键不转发', () => {
  const sent: MirroringControl[] = [];
  const keyboard = createMediaKeyboardControl({ ready: () => true, identity: () => 'session:1', enqueue: (values) => sent.push(...values) });
  keyboard.keyDown(event('KeyA'));
  for (let index = 0; index < 1100; index++) keyboard.keyDown(event('KeyA', { repeat: true }));
  assert.deepEqual(sent.at(-1), { type: 'key', action: 'down', keycode: 29, repeat: 1000, meta_state: 0 });
  keyboard.keyUp(event('KeyA', { key: 'Q' }));
  assert.deepEqual(sent.at(-1), { type: 'key', action: 'up', keycode: 29, meta_state: 0 });
  const count = sent.length;
  for (const key of ['Dead', 'Process', 'Unidentified']) assert.equal(keyboard.keyDown(event('KeyA', { key })), false);
  assert.equal(keyboard.keyDown(event('KeyA', { keyCode: 229 })), false);
  assert.equal(sent.length, count);
});

test('左右 Meta 使用 Android 主位和方向位，锁定位在释放中保留', () => {
  const sent: MirroringControl[] = [];
  const keyboard = createMediaKeyboardControl({ ready: () => true, identity: () => 'session:1', enqueue: (values) => sent.push(...values) });
  keyboard.keyDown(event('MetaLeft', { metaKey: true, modifiers: ['CapsLock'] }));
  assert.deepEqual(sent.at(-1), { type: 'key', action: 'down', keycode: 117, repeat: 0, meta_state: 0x10000 | 0x20000 | 0x100000 });
  keyboard.keyDown(event('MetaRight', { metaKey: true, modifiers: ['CapsLock'] }));
  keyboard.release();
  assert.deepEqual(sent.slice(-2), [
    { type: 'key', action: 'up', keycode: 118, meta_state: 0x10000 | 0x20000 | 0x100000 },
    { type: 'key', action: 'up', keycode: 117, meta_state: 0x100000 },
  ]);
});
