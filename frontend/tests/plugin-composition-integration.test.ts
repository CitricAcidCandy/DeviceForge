import assert from 'node:assert/strict';
import test from 'node:test';
import { HostError } from '../src/plugin-sdk/index.ts';
import type { HostContext, JsonValue, WebPlugin } from '../src/plugin-sdk/index.ts';
import { createPluginManager } from '../src/plugins/manager.ts';
import { deferred } from './fixtures.ts';

const service = { id: 'provider.read', version: '1' };
const point = { id: 'provider.tools', version: '1' };
const dataSource = {
  id: 'consumer.settings', version: '1', title: '设置', readOnly: true as const,
  applyPolicy: 'immediate' as const, read: service,
};
function fixture() {
  const never = () => new Promise<never>(() => {});
  const host: HostContext = {
    apiVersion: 2, signal: new AbortController().signal,
    listOperations: async () => ({ data: [], logId: null }),
    submit: never, getJob: never, cancelJob: never,
    subscribeOperations: () => () => {}, onDispose: () => () => {},
  };
  return createPluginManager({
    host, panelTarget: () => null,
    timeouts: { loadMs: 200, mountMs: 100, cleanupMs: 100 },
  });
}
function required(context: HostContext) {
  assert.ok(context.extensions?.points && context.ui && context.data && context.services);
  return { points: context.extensions.points, ui: context.ui, data: context.data, services: context.services };
}
function provider(): WebPlugin {
  return {
    id: 'provider', version: '1', apiVersion: 2, panels: [],
    contributions: { services: [{
      ...service, invoke: async () => ({ data: { value: { name: '公开数据' }, revision: 'r1' }, logId: 'read-log' }),
    }] },
    activate: async (context) => {
      const access = required(context);
      access.points.define({ ...point, title: '跨插件工具' });
      access.ui.register({
        workspaces: [{ id: 'provider.workspace', title: '工作区' }],
        views: [{ id: 'provider.view', title: '完整视图', mount: async () => () => {} }],
      });
    },
  };
}
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

test('真实管理器把扩展点、工作区和数据源绑定到功能作用域，依赖恢复保留布局并进入新代', async () => {
  const runtime = fixture();
  const features: HostContext[] = [];
  let consumer: HostContext | undefined;
  runtime.register({ id: 'provider', trusted: true, plugin: provider() });
  runtime.register({ id: 'consumer', trusted: true, plugin: {
    id: 'consumer', apiVersion: 2, version: '1', panels: [],
    contributions: { commands: [{ id: 'consumer.independent', title: '独立功能',
      execute: async () => ({ data: '仍可使用', logId: null }) }] },
    activate: async (context) => {
      consumer = context;
      required(context).services.whenAvailable('settings', [service], async (feature) => {
        features.push(feature);
        const access = required(feature);
        access.points.contribute({ id: 'consumer.tool', point, data: { title: '扩展工具' } });
        access.ui.register({ pages: [{ id: 'consumer.page', title: '扩展页面', route: '/independent',
          workspaceId: 'provider.workspace' }] });
        access.ui.open({ instanceId: 'consumer.main', workspaceId: 'provider.workspace',
          provider: { pluginId: 'provider', viewId: 'provider.view' } });
        access.ui.writeLayout('provider.workspace', {
          version: 1, root: { kind: 'view', instanceId: 'consumer.main' }, floating: [], overlays: [],
        });
        access.data.register(dataSource);
      });
    },
  } });
  try {
    await runtime.load('consumer'); await runtime.load('provider'); await settle();
    assert.equal(runtime.extensions.points.catalog().contributions[0]?.state, 'active',
      JSON.stringify(consumer?.services?.diagnostics()));
    assert.equal(runtime.extensions.workspaces.snapshot().instances[0]?.state, 'ready');
    assert.equal(runtime.extensions.dataSources.catalog()[0]?.id, dataSource.id);
    const first = features[0]; assert.ok(first);
    assert.equal((await required(first).data.read(dataSource, first.signal)).logId, 'read-log');
    const oldView = runtime.extensions.workspaces.resolveView('consumer.main'); assert.ok(oldView);
    const oldGeneration = oldView.instance.snapshot().generation;
    const layout = runtime.extensions.workspaces.hostAccess().readLayout('provider.workspace');

    await runtime.unload('provider'); await settle();
    assert.equal(first.signal.aborted, true);
    assert.equal(oldView.instance.signal.aborted, true);
    assert.equal(runtime.extensions.points.catalog().contributions.length, 0);
    assert.equal(runtime.extensions.workspaces.catalog().pages.length, 0);
    assert.equal(runtime.extensions.dataSources.catalog().length, 0);
    assert.equal(runtime.extensions.workspaces.snapshot().instances[0]?.reason, 'owner_inactive');
    assert.deepEqual(runtime.extensions.workspaces.hostAccess().readLayout('provider.workspace'), layout);
    assert.equal((await runtime.extensions.executeCommand('consumer.independent', null, new AbortController().signal)).data, '仍可使用');

    await runtime.load('provider'); await settle();
    assert.equal(features.length, 2);
    assert.equal(runtime.extensions.workspaces.snapshot().instances[0]?.state, 'ready');
    assert.ok((runtime.extensions.workspaces.snapshot().instances[0]?.generation ?? 0) > oldGeneration);
    const second = features[1]; assert.ok(second);
    assert.equal(required(second).data.catalog().length, 1);
    assert.throws(() => required(first).ui.open({ instanceId: 'consumer.old', workspaceId: 'provider.workspace', provider: null }), /撤销/);
  } finally { await runtime.dispose(); }
});

test('数据源转调原服务继承递归链，不因数据接口重新起算预算', async () => {
  const runtime = fixture();
  let calls = 0;
  const ref = { id: 'recursive.settings', version: '1' };
  runtime.register({ id: 'recursive', trusted: true, plugin: {
    id: 'recursive', version: '1', apiVersion: 2, panels: [],
    contributions: { services: [{ id: 'recursive.read', version: '1', invoke: async (_input, context, signal) => {
      if (++calls > 2) throw new Error('调用链被重置');
      const result = await required(context).data.read(ref, signal);
      return { data: { value: result.data.value, revision: result.data.revision }, logId: result.logId };
    } }] },
    activate: async (context) => { required(context).data.register({
      ...ref, title: '递归数据', readOnly: true, applyPolicy: 'immediate', read: { id: 'recursive.read', version: '1' },
    }); },
  } });
  try {
    await runtime.load('recursive');
    await assert.rejects(runtime.extensions.callService('recursive.read', '1', {}, AbortSignal.timeout(200)),
      (error: unknown) => error instanceof HostError && error.code === 'service_recursive_call');
    assert.equal(calls, 1);
  } finally { await runtime.dispose(); }
});

test('提供者换代撤销数据等待，旧结果不发布且不污染新版与旧SDK目录', async () => {
  const runtime = fixture();
  const entered = deferred<void>(), late = deferred<JsonValue>();
  let revision = 0;
  let consumer: HostContext | undefined;
  runtime.register({ id: 'provider', trusted: true, plugin: {
    ...provider(),
    contributions: {
      components: [{ id: 'provider.legacy', title: '旧面板', slot: 'developer.tools', mount: async () => () => {} }],
      services: [{ ...service, invoke: async () => {
        if (++revision === 1) { entered.resolve(); return { data: await late.promise, logId: 'old-log' }; }
        return { data: { value: '新版', revision: 'r2' }, logId: 'new-log' };
      } }],
    },
    activate: async (context) => { required(context).data.register({
      ...dataSource, id: 'provider.settings',
    }); },
  } });
  runtime.register({ id: 'consumer', trusted: true, plugin: {
    id: 'consumer', apiVersion: 2, version: '1', panels: [],
    activate: async (context) => { consumer = context; },
  } });
  try {
    await runtime.load('provider'); await runtime.load('consumer');
    assert.ok(consumer);
    const access = required(consumer).data;
    const ref = { id: 'provider.settings', version: '1' };
    const waiting = access.read(ref, new AbortController().signal);
    const rejected = assert.rejects(waiting, (error: unknown) => error instanceof HostError && error.kind === 'cancelled');
    await entered.promise;
    await runtime.unload('provider'); await rejected;
    await runtime.load('provider');
    late.resolve({ value: '旧版晚到', revision: 'r1' });
    await settle();
    assert.deepEqual((await access.read(ref, new AbortController().signal)).data, { value: '新版', revision: 'r2' });
    assert.equal(runtime.extensions.catalog().components[0]?.id, 'provider.legacy');
  } finally { late.resolve(null); await runtime.dispose(); }
});
