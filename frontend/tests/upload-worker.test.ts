import assert from 'node:assert/strict';
import test from 'node:test';
import { runUploadPreparation } from '../src/pages/marketplace/upload-preparation/index.ts';
import type { PreparationResponse } from '../src/pages/marketplace/upload-preparation/types.ts';

test('取消准备会终止Worker，旧线程晚到消息不能结算新请求', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  const workers: TestWorker[] = [];
  class TestWorker {
    onmessage: ((event: { data: PreparationResponse }) => void) | null = null;
    onerror: (() => void) | null = null;
    terminated = false;
    constructor() { workers.push(this); }
    postMessage() {}
    terminate() { this.terminated = true; }
  }
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: TestWorker });
  const file = new File(['x'], 'a.txt');
  const request = { kind: 'resource', selection: { mode: 'file', name: 'a.txt', files: [{ path: 'a.txt', file }] } } as const;
  const result = { files: [{ path: 'a.txt', size: 1 }], excluded: [], totalSize: 1, metadata: null, identity: null };
  try {
    const cancelled = new AbortController();
    const first = runUploadPreparation(request, cancelled.signal);
    cancelled.abort();
    await assert.rejects(first, /abort|取消/i);
    assert.equal(workers[0]?.terminated, true);
    const active = new AbortController();
    let resolved = false;
    const second = runUploadPreparation(request, active.signal).then(value => { resolved = true; return value; });
    workers[0]?.onmessage?.({ data: { ok: true, result } });
    await Promise.resolve();
    assert.equal(resolved, false);
    workers[1]?.onmessage?.({ data: { ok: true, result } });
    assert.deepEqual(await second, result);
    assert.equal(workers[1]?.terminated, true);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'Worker', previous);
    else Reflect.deleteProperty(globalThis, 'Worker');
  }
});
