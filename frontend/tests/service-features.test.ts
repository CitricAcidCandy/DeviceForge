import assert from 'node:assert/strict';
import test from 'node:test';
import { createPluginManager } from '../src/plugins/manager.ts';
import type { HostContext, ServiceAccess, WebPlugin } from '../src/plugin-sdk/index.ts';
import { deferred } from './fixtures.ts';
import providerExample from '../src/plugins/examples/service-provider.ts';
import consumerExample from '../src/plugins/examples/service-consumer.ts';
import { dom } from './dom-fixtures.ts';

function manager() {
  const forever = () => new Promise<never>(() => undefined);
  const host: HostContext = { apiVersion: 2, signal: new AbortController().signal,
    listOperations: async () => ({ data: [], logId: null }), submit: forever, getJob: forever,
    cancelJob: forever, subscribeOperations: () => () => undefined, onDispose: () => () => undefined };
  return createPluginManager({ host, panelTarget: () => null,
    timeouts: { loadMs: 100, mountMs: 100, cleanupMs: 50 } });
}
function provider(id: string): WebPlugin {
  return { id, apiVersion: 2, version: '1', panels: [], contributions: { services: [{
    id: `${id}.echo`, version: '1', inputSchema: { type: 'string' }, outputSchema: { type: 'string' },
    invoke: async (input) => ({ data: input, logId: 'service-log' }),
  }] } };
}
async function flush() { for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve)); }
function services(context: HostContext): ServiceAccess { assert.ok(context.services); return context.services; }

test('服务依赖只撤销相关功能，恢复使用新代并通过公开SDK重新注册', async () => {
  const runtime = manager();
  const contexts = new Map<string, HostContext[]>();
  let consumer: HostContext | undefined;
  let stopped = 0;
  for (const id of ['first', 'second']) runtime.register({ id, trusted: true, plugin: provider(id) });
  runtime.register({ id: 'consumer', trusted: true, plugin: { id: 'consumer', version: '1', apiVersion: 2, panels: [],
    activate: async (context) => {
      consumer = context;
      for (const id of ['first', 'second']) services(context).whenAvailable(id, [{ id: `${id}.echo`, version: '1' }], async (feature) => {
        const list = contexts.get(id) ?? []; list.push(feature); contexts.set(id, list);
        feature.extensions?.register?.({ commands: [{ id: `consumer.${id}`, title: id,
          execute: async (input, _context, signal) => services(feature).call({ id: `${id}.echo`, version: '1' }, input, signal) }] });
        return () => { stopped++; };
      });
    } } });
  try {
    await runtime.load('consumer');
    await flush();
    assert.deepEqual(services(consumer!).diagnostics().map((entry) => entry.state), ['waiting', 'waiting']);
    await runtime.load('first'); await runtime.load('second'); await flush();
    assert.equal(runtime.extensions.catalog().commands.length, 2);
    assert.equal((await runtime.extensions.executeCommand('consumer.first', 'ok', new AbortController().signal)).logId, 'service-log');
    const original = contexts.get('first')?.[0]; assert.ok(original);
    await runtime.unload('first'); await flush();
    assert.equal(original.signal.aborted, true);
    assert.equal(contexts.get('second')?.[0]?.signal.aborted, false);
    assert.deepEqual(runtime.extensions.catalog().commands.map((entry) => entry.id), ['consumer.second']);
    assert.equal(stopped, 1);
    assert.equal(services(consumer!).diagnostics().find((entry) => entry.featureId === 'first')?.state, 'waiting');
    await runtime.load('first'); await flush();
    assert.equal(contexts.get('first')?.length, 2);
    assert.equal(runtime.extensions.catalog().commands.length, 2);
    assert.equal(runtime.snapshot().find((entry) => entry.id === 'consumer')?.state, 'loaded');
  } finally { await runtime.dispose(); }
});

test('服务契约拒绝错误输入与错误输出，版本精确匹配', async () => {
  const runtime = manager();
  runtime.register({ id: 'first', trusted: true, plugin: provider('first') });
  runtime.register({ id: 'broken', trusted: true, plugin: { ...provider('broken'), contributions: { services: [{
    id: 'broken.echo', version: '1', outputSchema: { type: 'number' }, invoke: async () => ({ data: 'bad', logId: 'output-log' }),
  }] } } });
  try {
    await runtime.load('first'); await runtime.load('broken');
    assert.throws(() => runtime.extensions.callService('first.echo', '1', 42, new AbortController().signal), /输入/);
    assert.throws(() => runtime.extensions.callService('first.echo', '2', 'ok', new AbortController().signal), /版本/);
    await assert.rejects(runtime.extensions.callService('broken.echo', '1', null, new AbortController().signal), /输出/);
  } finally { await runtime.dispose(); }
});

test('激活完成之前服务不可用，失败激活不唤醒消费者', async () => {
  const runtime = manager();
  const entered = deferred<void>(); const finish = deferred<void>();
  const loadingPlugin = { ...provider('first'), activate: async () => { entered.resolve(); await finish.promise; } };
  runtime.register({ id: 'first', trusted: true, plugin: loadingPlugin });
  const loading = runtime.load('first');
  await entered.promise;
  assert.equal(runtime.extensions.catalog().services.length, 0);
  assert.throws(() => runtime.extensions.callService('first.echo', '1', 'ok', new AbortController().signal), /不可用/);
  finish.resolve(); await loading;
  assert.equal(runtime.extensions.catalog().services.length, 1);
  await runtime.dispose();
});

test('功能初始化晚到只释放原作用域，不登记或覆盖恢复后的功能', async () => {
  const runtime = manager();
  const late = deferred<() => void>();
  const contexts: HostContext[] = []; let releases = 0;
  runtime.register({ id: 'first', trusted: true, plugin: provider('first') });
  runtime.register({ id: 'consumer', trusted: true, plugin: { id: 'consumer', apiVersion: 2, version: '1', panels: [],
    activate: async (context) => { services(context).whenAvailable('delayed', [{ id: 'first.echo', version: '1' }], async (feature) => {
      contexts.push(feature);
      return contexts.length === 1 ? late.promise : () => { releases++; };
    }); } } });
  try {
    await runtime.load('first'); await runtime.load('consumer'); await flush();
    await runtime.unload('first'); await runtime.load('first'); await flush();
    assert.equal(contexts.length, 2);
    assert.equal(contexts[0]?.signal.aborted, true);
    assert.equal(contexts[1]?.signal.aborted, false);
    late.resolve(() => { releases++; }); await flush();
    assert.equal(releases, 1);
    assert.throws(() => contexts[0]?.extensions?.register?.({ commands: [] }), /撤销/);
  } finally { await runtime.dispose(); }
  assert.equal(releases, 2);
});

test('公开服务调用继承父链并拒绝递归，不拖死独立调用', async () => {
  const runtime = manager();
  runtime.register({ id: 'recursive', trusted: true, plugin: { id: 'recursive', apiVersion: 2, version: '1', panels: [],
    contributions: { services: [{ id: 'recursive.loop', version: '1', invoke: async (input, context, signal) =>
      services(context).call({ id: 'recursive.loop', version: '1' }, input, signal) }] } } });
  runtime.register({ id: 'first', trusted: true, plugin: provider('first') });
  try {
    await runtime.load('recursive'); await runtime.load('first');
    await assert.rejects(runtime.extensions.callService('recursive.loop', '1', null, new AbortController().signal), /递归/);
    assert.equal((await runtime.extensions.callService('first.echo', '1', 'ok', new AbortController().signal)).data, 'ok');
  } finally { await runtime.dispose(); }
});

test('服务经公开命令转调时仍继承调用链，不能绕过递归拒绝', async () => {
  const runtime = manager();
  let calls = 0;
  runtime.register({ id: 'bridge', trusted: true, plugin: { id: 'bridge', apiVersion: 2, version: '1', panels: [],
    contributions: {
      commands: [{ id: 'bridge.command', title: '转调', execute: async (input, context, signal) =>
        services(context).call({ id: 'bridge.service', version: '1' }, input, signal) }],
      services: [{ id: 'bridge.service', version: '1', invoke: async (input, context, signal) => {
        if (++calls > 2) throw new Error('调用链被重置');
        assert.ok(context.extensions);
        return context.extensions.executeCommand('bridge.command', input, signal);
      } }],
    } } });
  try {
    await runtime.load('bridge');
    await assert.rejects(runtime.extensions.callService('bridge.service', '1', null, AbortSignal.timeout(100)), /递归/);
  } finally { await runtime.dispose(); }
});

test('两个独立模板仅用公开SDK完成界面、路由、服务并在提供者恢复后重建', async () => {
  const runtime = manager();
  runtime.register({ id: providerExample.id, trusted: true, plugin: providerExample });
  runtime.register({ id: consumerExample.id, trusted: true, plugin: consumerExample });
  try {
    await runtime.load(consumerExample.id); await runtime.load(providerExample.id); await flush();
    assert.equal(runtime.extensions.catalog().modules[0]?.route, '/catalog');
    assert.equal(runtime.extensions.catalog().components[0]?.slot, 'workspace.sidebar');
    assert.equal((await runtime.extensions.executeCommand('example.service-consumer.echo', null, new AbortController().signal)).data, '组合服务已就绪');
    const entry = runtime.extensions.module('example.service-consumer.page'); assert.ok(entry);
    const target = dom(); const release = await entry.contribution.mount(target, entry.owner.context);
    const button = target.querySelector('button'); assert.ok(button); button.click(); await flush();
    assert.equal(target.querySelector('output')?.textContent, '组合服务已就绪'); await release();
    await runtime.unload(providerExample.id); await flush();
    assert.equal(runtime.extensions.catalog().modules.length, 0);
    assert.equal(runtime.snapshot().some((entry) => entry.id === consumerExample.id), true);
    await runtime.load(providerExample.id); await flush();
    assert.equal(runtime.extensions.catalog().modules.length, 1);
  } finally { await runtime.dispose(); }
});

test('功能旧代清理失败保留历史，不污染恢复后的可用状态', async () => {
  const runtime = manager(); let consumer: HostContext | undefined;
  runtime.register({ id: 'first', trusted: true, plugin: provider('first') });
  runtime.register({ id: 'consumer', trusted: true, plugin: { id: 'consumer', apiVersion: 2, version: '1', panels: [],
    activate: async (context) => { consumer = context;
      services(context).whenAvailable('cleanup', [{ id: 'first.echo', version: '1' }], async () =>
        () => { throw new Error('旧功能清理失败'); });
    } } });
  try {
    await runtime.load('first'); await runtime.load('consumer'); await flush();
    await runtime.unload('first'); await flush();
    const waiting = services(consumer!).diagnostics()[0];
    assert.equal(waiting?.state, 'waiting'); assert.equal(waiting?.cleanupErrors.length, 1);
    await runtime.load('first'); await flush();
    const restored = services(consumer!).diagnostics()[0];
    assert.equal(restored?.state, 'active'); assert.equal(restored?.cleanupErrors.length, 1);
  } finally { await runtime.dispose().catch(() => undefined); }
});

test('布尔Schema保持JSON Schema语义，不因清理编译缓存导致登记失败', async () => {
  const runtime = manager();
  runtime.register({ id: 'bool', trusted: true, plugin: { id: 'bool', apiVersion: 2, version: '1', panels: [],
    contributions: { services: [
      { id: 'bool.allow', version: '1', inputSchema: true, outputSchema: true, invoke: async (input) => ({ data: input, logId: null }) },
      { id: 'bool.deny', version: '1', inputSchema: false, outputSchema: true, invoke: async (input) => ({ data: input, logId: null }) },
    ] } } });
  try {
    await runtime.load('bool');
    assert.equal((await runtime.extensions.callService('bool.allow', '1', 'ok', new AbortController().signal)).data, 'ok');
    assert.throws(() => runtime.extensions.callService('bool.deny', '1', 'ok', new AbortController().signal), /输入/);
  } finally { await runtime.dispose(); }
});

test('同名功能重新登记后，旧清理错误合并历史而不覆盖新登记', async () => {
  const runtime = manager(); let consumer: HostContext | undefined;
  runtime.register({ id: 'first', trusted: true, plugin: provider('first') });
  runtime.register({ id: 'consumer', trusted: true, plugin: { id: 'consumer', version: '1', apiVersion: 2, panels: [], activate: async (context) => { consumer = context; } } });
  const oldCleanup = deferred<void>();
  try {
    await runtime.load('first'); await runtime.load('consumer');
    const access = services(consumer!);
    const stop = access.whenAvailable('same', [{ id: 'first.echo', version: '1' }], async () => () => oldCleanup.promise);
    await flush(); const stopping = Promise.resolve(stop());
    const next = access.whenAvailable('same', [{ id: 'first.echo', version: '1' }], async () => () => { throw new Error('新清理'); });
    await flush(); await next();
    oldCleanup.reject(new Error('旧清理')); await stopping; await flush();
    assert.equal(access.diagnostics()[0]?.cleanupErrors.length, 2);
    assert.equal(new Set(access.diagnostics()[0]?.cleanupErrors.map((error) => error.registration)).size, 2);
  } finally { await runtime.dispose(); }
});
