import assert from 'node:assert/strict';
import test from 'node:test';
import { createFrontendRuntime } from '../src/app/runtime.ts';
import type { WorkspaceStorageLike } from '../src/app/workspace-storage.ts';
import type { HostContext, WebPlugin } from '../src/plugin-sdk/index.ts';
import { createPluginScope } from '../src/plugins/scope.ts';
import { dom } from './dom-fixtures.ts';
import { deferred } from './fixtures.ts';

function storage() {
  const entries = new Map<string, string>();
  const access: WorkspaceStorageLike = {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, value); },
    removeItem: (key) => { entries.delete(key); },
  };
  return { entries, access };
}
function runtime(persistence: WorkspaceStorageLike, baseUrl = 'http://127.0.0.1:7031') {
  return createFrontendRuntime({
    baseUrl, workspaceStorage: persistence, panelTarget: () => null,
    transport: async () => { throw new Error('组合测试不能发起网络请求'); },
  });
}
function fixturePlugin(contexts: HostContext[]): WebPlugin {
  return {
    id: 'independent', version: '1', apiVersion: 2, panels: [],
    activate: async (context) => {
      contexts.push(context);
      assert.ok(context.ui && context.extensions?.points && context.transport && context.data);
      context.ui.register({
        pages: [{ id: 'independent.page', title: '独立页面', route: '/independent', workspaceId: 'independent.work' }],
        workspaces: [{ id: 'independent.work', title: '独立工作区' }],
        views: [{ id: 'independent.view', title: '独立视图', mount: async () => () => {} }],
      });
      context.ui.open({
        instanceId: 'independent.one', workspaceId: 'independent.work',
        provider: { pluginId: 'independent', viewId: 'independent.view' },
      });
      context.ui.writeLayout('independent.work', {
        version: 1, root: { kind: 'view', instanceId: 'independent.one' }, floating: [], overlays: [],
      });
    },
  };
}

test('实际runtime注入公开组合能力和持久布局，重建不会自动打开或重放业务', async () => {
  const persistence = storage(), contexts: HostContext[] = [];
  const plugin = fixturePlugin(contexts);
  const first = runtime(persistence.access);
  try {
    first.webPlugins.register({ id: plugin.id, trusted: true, plugin });
    await first.webPlugins.load(plugin.id);
    assert.ok(first.host.ui && first.host.data && first.host.extensions?.points && first.host.transport);
    first.host.ui.setTarget('independent.one', { draft: '保留草稿' });
    assert.equal(persistence.entries.size, 1);
    assert.equal(first.workspaceStorage?.snapshot().state, 'ready');
    const raw = [...persistence.entries.values()][0]; assert.ok(raw);
    assert.equal(raw.includes('generation'), false);
    assert.equal(raw.includes('mount'), false);
  } finally { await first.dispose(); }
  assert.equal(first.workspaceStorage?.snapshot().state, 'disposed');

  const second = runtime(persistence.access);
  try {
    assert.equal(contexts.length, 1);
    assert.equal(second.host.ui?.snapshot().instances[0]?.reason, 'owner_inactive');
    assert.deepEqual(second.host.ui?.snapshot().instances[0]?.target, { draft: '保留草稿' });
    second.webPlugins.register({ id: plugin.id, trusted: true, plugin });
    await second.webPlugins.load(plugin.id);
    assert.equal(contexts.length, 2);
    assert.equal(second.host.ui?.snapshot().instances[0]?.state, 'ready');
    assert.deepEqual(second.host.ui?.snapshot().instances[0]?.target, { draft: '保留草稿' });
  } finally { await second.dispose(); }
});

test('实际runtime的布局存储按服务器隔离，损坏源只暂停持久写而不阻止新插件', async () => {
  const persistence = storage();
  const key = 'deviceforge:workspaces:v1:http://127.0.0.1:7031';
  persistence.entries.set(key, '保留损坏的原始草稿');
  const first = runtime(persistence.access);
  const other = runtime(persistence.access, 'http://127.0.0.1:7032');
  try {
    const contexts: HostContext[] = [], plugin = fixturePlugin(contexts);
    first.webPlugins.register({ id: plugin.id, trusted: true, plugin });
    await first.webPlugins.load(plugin.id);
    assert.equal(first.workspaceStorage?.snapshot().state, 'blocked');
    assert.equal(first.host.ui?.catalog().pages[0]?.route, '/independent');
    assert.equal(persistence.entries.get(key), '保留损坏的原始草稿');
    assert.equal(other.host.ui?.snapshot().instances.length, 0);
    assert.equal(other.workspaceStorage?.snapshot().source, 'empty');
    assert.equal(first.workspaceStorage?.saveCurrent(), true);
    assert.notEqual(persistence.entries.get(key), '保留损坏的原始草稿');
  } finally { await Promise.allSettled([first.dispose(), other.dispose()]); }
});

test('独立外壳通过公开SDK挂载其他插件视图，功能子作用域退出不卸载提供者', async () => {
  const current = runtime(storage().access);
  let consumer: HostContext | undefined;
  let releases = 0;
  const views: HostContext[] = [];
  current.webPlugins.register({ id: 'provider', trusted: true, plugin: {
    id: 'provider', version: '1', apiVersion: 2, panels: [],
    activate: async (context) => {
      assert.ok(context.ui);
      context.ui.register({ views: [{ id: 'provider.view', title: '第三方完整视图',
        mount: async (target, mountedContext, instance) => {
          views.push(mountedContext);
          target.textContent = JSON.stringify(instance.snapshot().target);
          return () => { releases++; };
        },
      }] });
    },
  } });
  current.webPlugins.register({ id: 'shell', trusted: true, plugin: {
    id: 'shell', version: '1', apiVersion: 2, panels: [],
    activate: async (context) => {
      consumer = context;
      assert.ok(context.ui);
      context.ui.open({ instanceId: 'shell.one', workspaceId: 'shell.work',
        provider: { pluginId: 'provider', viewId: 'provider.view' }, target: '第一个目标' });
    },
  } });
  try {
    await current.webPlugins.load('provider'); await current.webPlugins.load('shell');
    assert.ok(consumer?.ui?.mount);
    const child = createPluginScope(consumer);
    assert.ok(child.context.ui?.mount);
    const oldTarget = dom();
    const oldRelease = await child.context.ui.mount('shell.one', oldTarget, child.context.signal);
    assert.equal(oldTarget.textContent, '"第一个目标"');
    assert.equal(views.length, 1);
    child.close();
    assert.equal(oldTarget.children.length, 0);
    await child.dispose();
    assert.equal(releases, 1);
    assert.equal(current.webPlugins.snapshot().find((item) => item.id === 'provider')?.state, 'loaded');

    consumer.ui.setTarget('shell.one', '新的目标');
    const newTarget = dom();
    const release = await consumer.ui.mount('shell.one', newTarget, consumer.signal);
    await oldRelease();
    assert.equal(newTarget.textContent, '"新的目标"');
    await release();
    assert.equal(newTarget.children.length, 0);
    assert.equal(releases, 2);
  } finally { await current.dispose(); }
});

test('实际runtime关闭会撤销根公开通信，不等待忽略取消的传输返回', async () => {
  const entered = deferred<void>(), response = deferred<Response>();
  const requested: { signal: AbortSignal | null | undefined } = { signal: undefined };
  const current = createFrontendRuntime({
    baseUrl: 'http://127.0.0.1:7031', workspaceStorage: null, panelTarget: () => null,
    transport: async (_input, init) => {
      requested.signal = init?.signal;
      entered.resolve();
      return response.promise;
    },
  });
  assert.ok(current.host.transport);
  const caller = new AbortController();
  const waiting = current.host.transport.request({ path: '/api/v2/example', method: 'GET' }, caller.signal);
  const cancelled = assert.rejects(waiting, /撤销|取消/);
  try {
    await entered.promise;
    await current.dispose();
    assert.equal(requested.signal?.aborted, true);
    await cancelled;
  } finally {
    caller.abort();
    response.resolve(new Response('{"data":null,"log_id":"late"}', { headers: { 'content-type': 'application/json' } }));
    await cancelled;
    await current.dispose();
  }
});
