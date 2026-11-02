import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { runUploadPreparation } from '../plugins/marketplace/src/workbench/upload-preparation/index.ts';
import type { PreparationResponse, PreparationRequest } from '../plugins/marketplace/src/workbench/upload-preparation/types.ts';

function workerFixture(unit: TestContext, postFailure?: Error) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  const workers: UploadWorker[] = [], timers = new Set<ReturnType<typeof setTimeout>>();
  const schedule = globalThis.setTimeout, cancel = globalThis.clearTimeout;
  class UploadWorker {
    terminated = 0;
    posts = 0;
    onmessage: ((event: MessageEvent<PreparationResponse>) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() { workers.push(this); }
    postMessage() { this.posts++; if (postFailure) throw postFailure; }
    terminate() { this.terminated++; }
  }
  Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: UploadWorker });
  unit.after(() => {
    if (original) Object.defineProperty(globalThis, 'Worker', original);
    else Reflect.deleteProperty(globalThis, 'Worker');
    for (const timer of timers) cancel(timer);
  });
  unit.mock.method(globalThis, 'setTimeout', (...args: Parameters<typeof setTimeout>) => {
    const timer = schedule(...args); timers.add(timer); return timer;
  });
  unit.mock.method(globalThis, 'clearTimeout', (...args: Parameters<typeof clearTimeout>) => {
    const timer = args[0];
    if (typeof timer === 'object' && timer !== null) timers.delete(timer);
    return cancel(...args);
  });
  return { workers, timers };
}

const input: PreparationRequest = {
  kind: 'plugin', selection: { mode: 'archive', name: 'sample.zip',
    files: [{ path: 'sample.zip', file: new File(['zip'], 'sample.zip') }] },
};
test('上传准备取消时终止自有线程并清除期限，不影响原选择', async (unit) => {
  const fixture = workerFixture(unit), controller = new AbortController();
  const waiting = runUploadPreparation(input, controller.signal);
  assert.equal(fixture.workers[0]?.posts, 1); assert.equal(fixture.timers.size, 1);
  const reason = new Error('页面已隐藏');
  controller.abort(reason);
  await assert.rejects(waiting, (error) => error === reason);
  assert.equal(fixture.workers[0]?.terminated, 1);
  assert.equal(fixture.timers.size, 0);
  assert.equal(input.selection.files[0]?.file.name, 'sample.zip');
});
test('上传准备同步发送失败清除线程和期限，预取消不创建线程', async (unit) => {
  const failure = new Error('消息发送失败'), fixture = workerFixture(unit, failure);
  await assert.rejects(runUploadPreparation(input, new AbortController().signal), (error) => error === failure);
  assert.equal(fixture.workers[0]?.terminated, 1);
  assert.equal(fixture.timers.size, 0);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(runUploadPreparation(input, cancelled.signal), { name: 'AbortError' });
  assert.equal(fixture.workers.length, 1);
});
