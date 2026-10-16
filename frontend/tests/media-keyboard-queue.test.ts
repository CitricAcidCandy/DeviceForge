import assert from 'node:assert/strict';
import test from 'node:test';
import { createMediaControlQueue } from '../src/pages/media/media-controls.ts';
import type { MirroringControl } from '../src/features/mirroring-streaming/index.ts';

test('积压长按合并重复事件，按键释放仍在首次按下之后发送', async () => {
  const received: MirroringControl[] = [];
  let unblock: () => void = () => {};
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  const queue = createMediaControlQueue({
    identity: () => 'session:1',
    send: async (value) => {
      received.push(value);
      if (received.length === 1) await blocked;
    },
    failed: (error) => { throw error; },
  });
  queue.enqueue([{ type: 'key', action: 'down', keycode: 51, repeat: 0 }]);
  for (let repeat = 1; repeat <= 1000; repeat++)
    queue.enqueue([{ type: 'key', action: 'down', keycode: 51, repeat }]);
  queue.enqueue([{ type: 'key', action: 'up', keycode: 51 }]);
  unblock();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(received, [
    { type: 'key', action: 'down', keycode: 51, repeat: 0 },
    { type: 'key', action: 'down', keycode: 51, repeat: 1000 },
    { type: 'key', action: 'up', keycode: 51 },
  ]);
  queue.dispose();
});

test('满队列优先淘汰重复按下，为后续释放保留顺序位置', async () => {
  const received: MirroringControl[] = [];
  let unblock: () => void = () => {};
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  const queue = createMediaControlQueue({
    identity: () => 'session:1',
    send: async (value) => {
      received.push(value);
      if (received.length === 1) await blocked;
    },
    failed: (error) => { throw error; },
  });
  queue.enqueue([{ type: 'key', action: 'down', keycode: 51, repeat: 0 }]);
  for (let index = 0; index < 128; index++) {
    queue.enqueue([{ type: 'key', action: 'down', keycode: 51, repeat: index + 1 }]);
    queue.enqueue([{ type: 'rotate' }]);
  }
  queue.enqueue([{ type: 'key', action: 'up', keycode: 51 }]);
  unblock();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(received.length, 257);
  assert.deepEqual(received.at(-1), { type: 'key', action: 'up', keycode: 51 });
  assert.equal(received.filter((value) => value.type === 'rotate').length, 128);
  queue.dispose();
});

test('控制交接清除旧修订中的待发粘贴，后续新控制修订仍可继续输入', async () => {
  const received: MirroringControl[] = [];
  let identity = 'session:control:1';
  let unblock: () => void = () => {};
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  const queue = createMediaControlQueue({
    identity: () => identity,
    send: async (value) => {
      received.push(value);
      if (received.length === 1) await blocked;
    },
    failed: (error) => { throw error; },
  });
  queue.enqueue([{ type: 'key', action: 'down', keycode: 51 }]);
  queue.enqueue([{ type: 'clipboard', text: '交接前待发粘贴', paste: true }]);
  identity = 'session:control:2';
  queue.clear();
  queue.enqueue([{ type: 'text', text: '新控制者输入' }]);
  unblock();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(received, [
    { type: 'key', action: 'down', keycode: 51 },
    { type: 'text', text: '新控制者输入' },
  ]);
  queue.dispose();
});
