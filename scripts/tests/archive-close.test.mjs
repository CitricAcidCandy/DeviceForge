import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { closeArchiveInput } from '../plugin-releases/archive-close.mjs';

function trackedInput(context, closed = false) {
  const input = new EventEmitter();
  input.closed = closed;
  input.destroy = context.mock.fn(() => input);
  input.on('close', () => {});
  input.on('error', () => {});
  return input;
}

function mockCloseTimers(context) {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const scheduled = context.mock.method(globalThis, 'setTimeout');
  const cleared = context.mock.method(globalThis, 'clearTimeout');
  context.after(() => {
    context.mock.restoreAll();
    context.mock.timers.reset();
  });
  return { scheduled, cleared };
}

function listeners(input) {
  return { close: input.listeners('close'), error: input.listeners('error') };
}

test('归档输入已关闭时不重复destroy或登记等待', async (context) => {
  const { scheduled, cleared } = mockCloseTimers(context);
  const input = trackedInput(context, true);
  const original = listeners(input);
  await closeArchiveInput(input);
  assert.equal(input.destroy.mock.callCount(), 0);
  assert.equal(scheduled.mock.callCount(), 0);
  assert.equal(cleared.mock.callCount(), 0);
  assert.deepEqual(listeners(input), original);
});

test('归档输入等待晚到close后只清理自有监听与定时器', async (context) => {
  const { scheduled, cleared } = mockCloseTimers(context);
  const input = trackedInput(context);
  const original = listeners(input);
  let settled = false;
  const closing = closeArchiveInput(input).then(() => { settled = true; });
  assert.equal(input.destroy.mock.callCount(), 1);
  assert.equal(input.listenerCount('close'), original.close.length + 1);
  assert.equal(input.listenerCount('error'), original.error.length + 1);
  assert.equal(scheduled.mock.callCount(), 1);
  assert.equal(scheduled.mock.calls[0].arguments[1], 5000);
  context.mock.timers.tick(4999);
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(cleared.mock.callCount(), 0);
  input.closed = true;
  input.emit('close');
  await closing;
  assert.equal(settled, true);
  assert.deepEqual(listeners(input), original);
  assert.equal(cleared.mock.callCount(), 1);
  assert.equal(cleared.mock.calls[0].arguments[0], scheduled.mock.calls[0].result);
});

test('归档输入永不close时固定5秒失败并移除自有监听与定时器', async (context) => {
  const { scheduled, cleared } = mockCloseTimers(context);
  const input = trackedInput(context);
  const original = listeners(input);
  let settled = false;
  const closing = closeArchiveInput(input).finally(() => { settled = true; });
  const rejected = assert.rejects(closing, /归档文件输入关闭超过5秒，关闭状态未确认/);
  assert.equal(input.destroy.mock.callCount(), 1);
  assert.equal(scheduled.mock.callCount(), 1);
  assert.equal(scheduled.mock.calls[0].arguments[1], 5000);
  context.mock.timers.tick(4999);
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(input.listenerCount('close'), original.close.length + 1);
  assert.equal(input.listenerCount('error'), original.error.length + 1);
  context.mock.timers.tick(1);
  await rejected;
  assert.equal(settled, true);
  assert.equal(input.closed, false);
  assert.deepEqual(listeners(input), original);
  assert.equal(cleared.mock.callCount(), 1);
  assert.equal(cleared.mock.calls[0].arguments[0], scheduled.mock.calls[0].result);
});
