import assert from 'node:assert/strict';
import test from 'node:test';
import { HostError } from '../src/plugin-sdk/index.ts';
import type { HostContext, HostResult, Job, JsonValue, TaskSubmission } from '../src/plugin-sdk/index.ts';
import { createPluginManager } from '../src/plugins/manager.ts';
import { createPluginScope } from '../src/plugins/scope.ts';
import { createExtensionRegistry } from '../src/plugins/extensions/registry.ts';
import { awaitActive } from '../src/plugins/extensions/await-active.ts';
import { deferred } from './fixtures.ts';

type Entry = 'command' | 'service' | 'hook';
type Cause = 'caller' | 'provider' | 'registry';
const entries: readonly Entry[] = ['command', 'service', 'hook'];
const causes: readonly Cause[] = ['caller', 'provider', 'registry'];
const cancelled = (error: unknown) => error instanceof HostError && error.kind === 'cancelled';
const result: HostResult<JsonValue> = { data: '完成', logId: null };

function host(registry: ReturnType<typeof createExtensionRegistry>): HostContext {
  const lifetime = new AbortController();
  const job: Job = { id: 'job', operation: 'example.run', status: 'queued', result: null, error: null };
  return {
    apiVersion: 2, signal: lifetime.signal,
    listOperations: async () => ({ data: [], logId: null }),
    async submit(operation, input, signal) {
      await registry.beforeTaskSubmit({ operation, input }, signal);
      return { data: job, logId: null };
    },
    getJob: async () => ({ data: job, logId: null }),
    cancelJob: async () => ({ data: job, logId: null }),
    subscribeOperations: () => () => {},
    onDispose: (release) => release,
  };
}

function contributions(callback: (signal: AbortSignal) => Promise<void>) {
  return {
    commands: [{ id: 'provider.command', title: '命令', execute: async (_input: JsonValue, _context: HostContext, signal: AbortSignal) => {
      await callback(signal); return result;
    } }],
    services: [{ id: 'provider.service', version: '1', invoke: async (_input: JsonValue, _context: HostContext, signal: AbortSignal) => {
      await callback(signal); return result;
    } }],
    beforeTaskSubmit: [{ id: 'provider.hook', transform: async (input: TaskSubmission, _context: HostContext, signal: AbortSignal) => {
      await callback(signal); return input;
    } }],
  };
}

function fixture(callback: (signal: AbortSignal) => Promise<void>) {
  const registry = createExtensionRegistry();
  const provider = createPluginScope(host(registry));
  provider.track(registry.register({ pluginId: 'provider', generation: 1, context: provider.context }, contributions(callback)));
  return {
    registry, provider,
    start(entry: Entry, signal: AbortSignal): Promise<unknown> {
      switch (entry) {
        case 'command': return registry.executeCommand('provider.command', null, signal);
        case 'service': return registry.callService('provider.service', '1', null, signal);
        case 'hook': return registry.beforeTaskSubmit({ operation: 'example.run', input: null }, signal);
      }
    },
    async dispose() { registry.dispose(); await provider.dispose(); },
  };
}

for (const entry of entries) {
  test(`${entry}回调永不返回时，调用者、提供者和注册表撤销均结束宿主等待`, async () => {
    for (const cause of causes) {
      const entered = deferred<AbortSignal>();
      const environment = fixture((signal) => { entered.resolve(signal); return new Promise<void>(() => {}); });
      try {
        const caller = new AbortController();
        const pending = environment.start(entry, caller.signal);
        const rejected = assert.rejects(pending, cancelled);
        const callbackSignal = await entered.promise;
        switch (cause) {
          case 'caller': caller.abort(); break;
          case 'provider': environment.provider.close(); break;
          case 'registry': environment.registry.dispose(); break;
        }
        // 不令回调完成；取消本身必须令等待完成。
        await rejected;
        assert.equal(callbackSignal.aborted, true);
      } finally { await environment.dispose(); }
    }
  });
}

test('预取消的命令、服务和钩子不进入可信插件回调', async () => {
  let callbacks = 0;
  const environment = fixture(async () => { ++callbacks; });
  try {
    const caller = new AbortController(); caller.abort();
    for (const entry of entries) await assert.rejects(environment.start(entry, caller.signal), cancelled);
    assert.equal(callbacks, 0);
  } finally { await environment.dispose(); }
});

test('调用者插件卸载取消其命令、服务和提交钩子的等待，不卸载提供者', async () => {
  for (const entry of entries) {
    const entered = deferred<AbortSignal>();
    const registry = createExtensionRegistry();
    const manager = createPluginManager({ host: host(registry), extensionRegistry: registry, panelTarget: () => null });
    const activated = deferred<HostContext>();
    manager.register({ id: 'provider', trusted: true, plugin: {
      id: 'provider', version: '1', apiVersion: 2, panels: [],
      contributions: contributions((signal) => { entered.resolve(signal); return new Promise<void>(() => {}); }),
    } });
    manager.register({ id: 'consumer', trusted: true, plugin: {
      id: 'consumer', version: '1', apiVersion: 2, panels: [],
      activate: async (context) => { activated.resolve(context); },
    } });
    try {
      await manager.load('provider'); await manager.load('consumer');
      const current = await activated.promise;
      const access = current.extensions; assert.ok(access);
      const caller = new AbortController();
      const pending = entry === 'command' ? access.executeCommand('provider.command', null, caller.signal)
        : entry === 'service' ? access.callService('provider.service', '1', null, caller.signal)
          : current.submit('example.run', null, caller.signal);
      const rejected = assert.rejects(pending, cancelled);
      const callbackSignal = await entered.promise;
      await manager.unload('consumer'); await rejected;
      assert.equal(callbackSignal.aborted, true);
      assert.equal(caller.signal.aborted, false);
      assert.equal(manager.snapshot().find((plugin) => plugin.id === 'provider')?.state, 'loaded');
    } finally { await manager.dispose(); registry.dispose(); }
  }
});

test('取消后的晚到成功或拒绝不改变宿主结果，也不产生未处理拒绝', async (t) => {
  const unhandled: unknown[] = [];
  const observe = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', observe);
  t.after(() => { process.off('unhandledRejection', observe); });
  for (const entry of entries) {
    for (const outcome of ['resolve', 'reject']) {
      const entered = deferred<void>(); const gate = deferred<void>();
      const environment = fixture(() => { entered.resolve(undefined); return gate.promise; });
      try {
        const caller = new AbortController(); const states: string[] = [];
        const pending = environment.start(entry, caller.signal);
        const observed = pending.then(() => { states.push('成功'); }, () => { states.push('取消'); });
        const rejected = assert.rejects(pending, cancelled);
        await entered.promise; caller.abort(); await rejected; await observed;
        if (outcome === 'resolve') gate.resolve(undefined); else gate.reject(new Error('晚到拒绝'));
        // 跨一轮事件循环检查拒绝处理，不等待墙钟时间。
        await new Promise<void>((resolve) => { setImmediate(resolve); });
        assert.deepEqual(states, ['取消']); assert.deepEqual(unhandled, []);
      } finally { await environment.dispose(); }
    }
  }
  const caller = new AbortController(); const gate = deferred<string>();
  const pending = awaitActive(() => { caller.abort(); return gate.promise; }, caller.signal);
  await assert.rejects(pending, cancelled);
  gate.reject(new Error('同步取消后晚到拒绝'));
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.deepEqual(unhandled, []);
});

test('取消竞速在成功、拒绝、同步抛错、取消和预取消各分支移除监听', async (t) => {
  type Branch = 'resolve' | 'reject' | 'throw' | 'cancel' | 'pre_cancel';
  const branches: readonly Branch[] = ['resolve', 'reject', 'throw', 'cancel', 'pre_cancel'];
  for (const branch of branches) {
    const controller = new AbortController(); const gate = deferred<string>();
    if (branch === 'pre_cancel') controller.abort();
    const add = t.mock.method(controller.signal, 'addEventListener');
    const remove = t.mock.method(controller.signal, 'removeEventListener');
    const failure = new Error('回调失败'); let callbacks = 0;
    const pending = awaitActive(() => { ++callbacks; if (branch === 'throw') throw failure; return gate.promise; }, controller.signal);
    if (branch === 'resolve') {
      gate.resolve('完成'); assert.equal(await pending, '完成');
    } else {
      const rejected = assert.rejects(pending, branch === 'reject' || branch === 'throw'
        ? (error: unknown) => error === failure : cancelled);
      if (branch === 'reject') gate.reject(failure);
      if (branch === 'cancel') controller.abort();
      await rejected;
    }
    assert.equal(callbacks, branch === 'pre_cancel' ? 0 : 1);
    assert.equal(add.mock.callCount(), branch === 'pre_cancel' ? 0 : 1);
    assert.equal(remove.mock.callCount(), branch === 'pre_cancel' ? 0 : 1);
    if (branch !== 'pre_cancel') {
      assert.equal(add.mock.calls[0]?.arguments[0], 'abort');
      assert.equal(remove.mock.calls[0]?.arguments[0], 'abort');
      assert.equal(add.mock.calls[0]?.arguments[1], remove.mock.calls[0]?.arguments[1]);
    }
  }
});
