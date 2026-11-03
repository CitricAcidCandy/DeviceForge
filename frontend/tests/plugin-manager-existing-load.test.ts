import assert from 'node:assert/strict';
import test from 'node:test';
import { HostError } from '../src/plugin-sdk/index.ts';
import type { HostContext } from '../src/plugin-sdk/index.ts';
import { createPluginManager } from '../src/plugins/manager.ts';
import { deferred, signal } from './fixtures.ts';

const turn = () => new Promise<void>((resolve) => { setImmediate(resolve); });
function fixture(loadMs = 1000, cleanup?: Promise<void>) {
  const lifetime = new AbortController();
  const gates = [deferred<void>(), deferred<void>()];
  const entered = [deferred<void>(), deferred<void>()];
  const calls: AbortSignal[] = [];
  const unavailable = async (): Promise<never> => { throw new Error('本单元不调用业务请求'); };
  const host: HostContext = {
    apiVersion: 2, signal: lifetime.signal, onDispose: (release) => release,
    listOperations: async () => ({ data: [], logId: null }),
    subscribeOperations: () => () => {}, submit: unavailable, getJob: unavailable, cancelJob: unavailable,
  };
  const manager = createPluginManager({ host, panelTarget: () => null, timeouts: { loadMs, cleanupMs: 100 } });
  manager.register({ id: 'existing', trusted: true, plugin: {
    id: 'existing', version: '1.0.0', apiVersion: 2, panels: [],
    async activate(context) {
      if (cleanup) context.onDispose(() => cleanup);
      const index = calls.length;
      calls.push(context.signal);
      const gate = gates[index], ready = entered[index]; assert.ok(gate && ready);
      ready.resolve(); await gate.promise;
    },
  } });
  const loading = manager.load('existing');
  void loading.catch(() => undefined);
  return { manager, gates, entered, calls, loading,
    async dispose() {
      for (const gate of gates) gate.resolve();
      await loading.catch(() => undefined); await manager.dispose(); lifetime.abort();
    },
  };
}

test('多个同代只读等待彼此隔离，一个取消不撤销原加载或其他等待者', async () => {
  const f = fixture();
  await f.entered[0]?.promise;
  const current = f.manager.snapshot()[0]; assert.ok(current);
  const caller = new AbortController();
  const first = f.manager.waitForLoaded(current.id, current.generation, caller.signal);
  const second = f.manager.waitForLoaded(current.id, current.generation, signal());
  void first.catch(() => undefined); void second.catch(() => undefined);
  try {
    caller.abort();
    await assert.rejects(first, (reason: unknown) => reason instanceof HostError && reason.kind === 'cancelled');
    assert.equal(f.calls[0]?.aborted, false);
    f.gates[0]?.resolve();
    const loaded = await f.loading;
    assert.deepEqual(await second, loaded);
    assert.deepEqual(await f.manager.waitForLoaded(current.id, current.generation, signal()), loaded);
    assert.equal(f.calls.length, 1);
  } finally { await f.dispose(); }
});

test('原加载被卸载后旧等待不能追随新代，旧回调晚到不污染新成功', async () => {
  const f = fixture();
  await f.entered[0]?.promise;
  const current = f.manager.snapshot()[0]; assert.ok(current);
  const waiting = f.manager.waitForLoaded(current.id, current.generation, signal());
  void waiting.catch(() => undefined);
  try {
    await f.manager.unload(current.id);
    await assert.rejects(f.loading);
    await assert.rejects(waiting, (reason: unknown) => reason instanceof HostError && reason.kind === 'cancelled');
    const reloading = f.manager.load(current.id);
    void reloading.catch(() => undefined);
    await f.entered[1]?.promise;
    await assert.rejects(f.manager.waitForLoaded(current.id, current.generation, signal()),
      (reason: unknown) => reason instanceof HostError && reason.code === 'plugin_load_changed');
    const newer = f.manager.snapshot()[0]; assert.ok(newer && newer.generation !== current.generation);
    f.gates[1]?.resolve(); const loaded = await reloading;
    f.gates[0]?.resolve(); await turn();
    assert.deepEqual(f.manager.snapshot(), [loaded]);
    assert.equal(f.calls.length, 2);
  } finally { await f.dispose(); }
});

test('只读等待复用原加载绝对期限，不因为后到等待而延长预算', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const f = fixture(100);
  await f.entered[0]?.promise;
  const current = f.manager.snapshot()[0]; assert.ok(current);
  t.mock.timers.tick(80);
  let settled = false;
  const waiting = f.manager.waitForLoaded(current.id, current.generation, signal());
  void waiting.then(() => { settled = true; }, () => { settled = true; });
  try {
    await turn(); t.mock.timers.tick(19); await turn();
    assert.equal(settled, false);
    t.mock.timers.tick(1);
    await assert.rejects(waiting, (reason: unknown) => reason instanceof HostError && reason.code === 'plugin_lifecycle_timeout');
    await assert.rejects(f.loading, (reason: unknown) => reason instanceof HostError && reason.code === 'plugin_lifecycle_timeout');
    assert.equal(f.calls[0]?.aborted, true);
    assert.equal(f.calls.length, 1);
  } finally { await f.dispose(); }
});

test('原激活抛出null也明确拒绝，只读等待不把空错误误认成成功', async () => {
  const f = fixture();
  await f.entered[0]?.promise;
  const current = f.manager.snapshot()[0]; assert.ok(current);
  const waiting = f.manager.waitForLoaded(current.id, current.generation, signal());
  void waiting.catch(() => undefined);
  try {
    f.gates[0]?.reject(null);
    await assert.rejects(f.loading, (reason: unknown) => reason === null);
    await assert.rejects(waiting, (reason: unknown) => reason === null);
    assert.equal(f.calls.length, 1);
  } finally { await f.dispose(); }
});

test('原加载失败正在回收时后到等待仍返回原错，不用过期预算覆盖已知失败', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const cleanup = deferred<void>();
  const f = fixture(50, cleanup.promise);
  const failure = new Error('已确认的原激活失败');
  await f.entered[0]?.promise;
  const current = f.manager.snapshot()[0]; assert.ok(current);
  try {
    f.gates[0]?.reject(failure); await turn();
    assert.equal(f.calls[0]?.aborted, true, '原失败已进入自己的回收');
    t.mock.timers.tick(60);
    await assert.rejects(f.manager.waitForLoaded(current.id, current.generation, signal()),
      (reason: unknown) => reason === failure);
    cleanup.resolve();
    await assert.rejects(f.loading, (reason: unknown) => reason === failure);
  } finally { cleanup.resolve(); await f.dispose(); }
});
