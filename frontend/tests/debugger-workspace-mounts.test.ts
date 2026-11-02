import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { HostError } from '../src/plugin-sdk/index.ts';
import type { Dispose, HostContext, WebPlugin } from '../src/plugin-sdk/index.ts';
import { createLocalDebugger } from '../src/app/debugger-local/index.ts';
import type { LocalDebugger } from '../src/app/debugger-local/index.ts';
import { createExtensionRegistry } from '../src/plugins/extensions/registry.ts';
import { createPluginManager } from '../src/plugins/manager.ts';

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}
function records(value: unknown): readonly Record<string, unknown>[] {
  assert.ok(Array.isArray(value));
  return value.map(record);
}
function host(signal: AbortSignal): HostContext {
  return {
    apiVersion: 2, signal, listOperations: async () => ({ data: [], logId: null }),
    submit: async () => { throw new Error('本测试不提交业务操作'); },
    getJob: async () => { throw new Error('本测试不查询作业'); },
    cancelJob: async () => { throw new Error('本测试不取消后台作业'); },
    subscribeOperations: () => () => {}, onDispose: () => () => {},
  };
}
async function fixture() {
  const dom = new JSDOM('<main></main><aside></aside>');
  const document = dom.window.document;
  const main = document.querySelector('main');
  const aside = document.querySelector('aside');
  assert.ok(main && aside);
  const lifetime = new AbortController();
  const extensions = createExtensionRegistry();
  const contexts = new Map<string, HostContext>();
  let local: LocalDebugger | undefined;
  const manager = createPluginManager({
    host: host(lifetime.signal), extensionRegistry: extensions, panelTarget: () => aside,
    debugForPlugin(pluginId, generation, scope) {
      assert.ok(local);
      return local.attach(pluginId, String(generation), scope);
    },
  });
  local = createLocalDebugger({
    document, signal: lifetime.signal, manager: () => manager, extensions,
    slots: [{ id: 'legacy.slot', label: '旧槽位', modes: ['append', 'replace'], description: '只测试兼容语义' }],
  });
  const debuggerLocal = local;
  const mount = async (root: HTMLElement): Promise<Dispose> => {
    const content = document.createElement('button');
    content.textContent = '实际视图内容';
    root.append(content);
    return () => {};
  };
  const provider: WebPlugin = {
    id: 'provider', apiVersion: 2, version: '1',
    panels: [{ id: 'provider.panel', title: '旧面板', mount }],
    contributions: {
      components: [{ id: 'provider.component', title: '旧组件', slot: 'legacy.slot', mount }],
      modules: [{ id: 'provider.module', title: '旧模块', route: '/legacy', mount }],
    },
    async activate(context) {
      contexts.set('provider', context);
      assert.ok(context.ui);
      context.ui.register({ views: [{ id: 'provider.view', title: '统一工作区视图', mount }] });
    },
  };
  manager.register({ id: 'provider', trusted: true, plugin: provider });
  manager.register({ id: 'foreign', trusted: true, plugin: {
    id: 'foreign', apiVersion: 2, version: '1', panels: [],
    async activate(context) {
      contexts.set('foreign', context);
      assert.ok(context.ui);
      context.ui.register({ views: [{ id: 'foreign.view', title: '其他插件视图', mount }] });
    },
  } });
  manager.register({ id: 'shell', trusted: true, plugin: {
    id: 'shell', apiVersion: 2, version: '1', panels: [],
    async activate(context) {
      contexts.set('shell', context);
      assert.ok(context.ui);
      context.ui.register({ workspaces: [
        { id: 'shell.devices', title: '设备工作区' }, { id: 'shell.files', title: '文件工作区' },
      ] });
    },
  } });
  let generation = String((await manager.load('provider')).generation);
  await manager.load('foreign');
  await manager.load('shell');
  const shell = contexts.get('shell');
  assert.ok(shell?.ui?.mount);
  const ui = shell.ui;
  const render = ui.mount;
  assert.ok(render);
  const target = () => ({ plugin_id: 'provider', generation });
  function select() { debuggerLocal.select([target()]); }
  select();
  function open(instanceId: string, workspaceId = 'shell.devices', providerId = 'provider') {
    return ui.open({
      instanceId, workspaceId, provider: { pluginId: providerId, viewId: `${providerId}.view` },
      target: { secretTargetValue: '不允许复制到挂载目录' },
    });
  }
  const inspect = async () => record(await debuggerLocal.execute('inspect', target(), {}, lifetime.signal));
  const mounts = async () => records((await inspect()).mount_catalog);
  const workspaceMounts = async () => (await mounts()).filter((entry) => entry.kind === 'workspace');
  return {
    document, main, aside, extensions, contexts, manager, local: debuggerLocal, lifetime,
    ui, open, target, inspect, mounts, workspaceMounts,
    render: (instanceId: string, destination = main) => render(instanceId, destination, shell.signal),
    async reload() {
      await manager.unload('provider');
      generation = String((await manager.load('provider')).generation);
      select();
    },
    async overview() {
      return record(await debuggerLocal.execute('ui_tree', target(), { view: 'overview' }, lifetime.signal));
    },
    async close() {
      debuggerLocal.dispose();
      await manager.dispose();
      await extensions.dispose();
      lifetime.abort();
      dom.window.close();
    },
  };
}

test('工作区目录按视图提供者列出独立实例，ready状态不冒充DOM挂载', async () => {
  const f = await fixture();
  try {
    const first = f.open('shell.first');
    f.open('shell.second', 'shell.files');
    f.open('shell.foreign', 'shell.devices', 'foreign');
    const before = await f.workspaceMounts();
    assert.equal(before.length, 2);
    assert.deepEqual(before.map((entry) => entry.instance_id).sort(), ['shell.first', 'shell.second']);
    assert.ok(before.every((entry) => entry.mounted === false && entry.dom_observed === false));
    const one = before.find((entry) => entry.instance_id === 'shell.first');
    assert.ok(one);
    assert.equal(one.id, `workspace.shell.first.${first.generation}`);
    assert.equal(one.workspace_id, 'shell.devices');
    assert.equal(one.view_id, 'provider.view');
    assert.equal(one.instance_generation, first.generation);
    assert.deepEqual(one.owner, { pluginId: 'provider', generation: Number(f.target().generation) });
    assert.equal(one.slot_id, null);
    assert.equal(one.label, '统一工作区视图');
    const release = await f.render('shell.first');
    const mounted = await f.workspaceMounts();
    assert.equal(mounted.find((entry) => entry.instance_id === 'shell.first')?.mounted, true);
    assert.equal(mounted.find((entry) => entry.instance_id === 'shell.second')?.mounted, false);
    const serialized = JSON.stringify(mounted);
    assert.equal(serialized.includes('secretTargetValue'), false);
    assert.equal(serialized.includes('不允许复制到挂载目录'), false);
    assert.equal(serialized.includes('shell.foreign'), false);
    assert.equal(serialized.includes('"layout"'), false);
    await release();
    assert.ok((await f.workspaceMounts()).every((entry) => entry.mounted === false));
  } finally { await f.close(); }
});

test('实例换代及错误归属锚点不计为挂载，调试器自身子树保持排除', async () => {
  const f = await fixture();
  try {
    const first = f.open('shell.first');
    const release = await f.render('shell.first');
    const root = f.main.querySelector('[data-deviceforge-workspace-instance]');
    assert.ok(root);
    function clone() {
      const element = f.document.createElement('div');
      assert.ok(root);
      for (const attribute of root.attributes) element.setAttribute(attribute.name, attribute.value);
      return element;
    }
    const stale = clone();
    await release();
    const next = f.ui.setTarget('shell.first', { nextPrivateTarget: '仍不输出' });
    assert.notEqual(next.generation, first.generation);
    f.main.append(stale);
    assert.equal((await f.workspaceMounts())[0]?.mounted, false);
    const candidate = clone();
    candidate.setAttribute('data-deviceforge-extension', `workspace.shell.first.${next.generation}`);
    candidate.setAttribute('data-deviceforge-workspace-generation', String(next.generation));
    candidate.setAttribute('data-deviceforge-workspace-view', 'foreign.view');
    f.main.append(candidate);
    assert.equal((await f.workspaceMounts())[0]?.mounted, false);
    candidate.setAttribute('data-deviceforge-workspace-view', 'provider.view');
    candidate.setAttribute('data-deviceforge-workspace-instance', 'shell.other');
    assert.equal((await f.workspaceMounts())[0]?.mounted, false);
    candidate.setAttribute('data-deviceforge-workspace-instance', 'shell.first');
    candidate.setAttribute('data-deviceforge-generation', String(Number(f.target().generation) + 100));
    assert.equal((await f.workspaceMounts())[0]?.mounted, false);
    candidate.setAttribute('data-deviceforge-generation', f.target().generation);
    const internal = f.document.createElement('div');
    internal.setAttribute('data-deviceforge-debugger-internal', '');
    internal.append(candidate);
    f.main.append(internal);
    assert.equal((await f.workspaceMounts())[0]?.mounted, false);
    const currentRelease = await f.render('shell.first');
    const current = (await f.workspaceMounts())[0];
    assert.equal(current?.mounted, true);
    assert.equal(current?.instance_generation, next.generation);
    assert.notEqual(current?.id, `workspace.shell.first.${first.generation}`);
    await currentRelease();
  } finally { await f.close(); }
});

test('隐藏保留真实DOM证据，卸载与关闭只撤销对应实例的挂载目录', async () => {
  const f = await fixture();
  try {
    f.open('shell.first');
    f.open('shell.second', 'shell.files');
    const releaseFirst = await f.render('shell.first');
    const releaseSecond = await f.render('shell.second');
    f.ui.setVisible('shell.first', false);
    assert.ok((await f.workspaceMounts()).every((entry) => entry.mounted === true));
    await releaseFirst();
    const oneRemaining = await f.workspaceMounts();
    assert.equal(oneRemaining.find((entry) => entry.instance_id === 'shell.first')?.mounted, false);
    assert.equal(oneRemaining.find((entry) => entry.instance_id === 'shell.second')?.mounted, true);
    f.ui.close('shell.first');
    assert.deepEqual((await f.workspaceMounts()).map((entry) => entry.instance_id), ['shell.second']);
    await releaseSecond();
    assert.equal((await f.workspaceMounts())[0]?.dom_observed, false);
  } finally { await f.close(); }
});

test('提供者卸载撤销DOM，重载只列新提供者代次且不把保留实例自动认作已挂载', async () => {
  const f = await fixture();
  try {
    f.open('shell.first');
    const oldTarget = f.target();
    const oldRelease = await f.render('shell.first');
    const previous = (await f.workspaceMounts())[0];
    assert.ok(previous);
    const oldRoot = f.main.querySelector('[data-deviceforge-workspace-instance]');
    assert.ok(oldRoot);
    const stale = f.document.createElement('div');
    for (const attribute of oldRoot.attributes) stale.setAttribute(attribute.name, attribute.value);
    await f.reload();
    assert.equal(oldRoot.isConnected, false);
    f.main.append(stale);
    assert.notEqual(f.target().generation, oldTarget.generation);
    await assert.rejects(
      f.local.execute('inspect', oldTarget, {}, f.lifetime.signal),
      (error: unknown) => error instanceof HostError && error.code === 'debugger_stale_generation',
    );
    const current = await f.workspaceMounts();
    assert.equal(current.length, 1);
    assert.equal(current[0]?.mounted, false);
    assert.notEqual(current[0]?.id, previous.id);
    assert.deepEqual(current[0]?.owner, { pluginId: 'provider', generation: Number(f.target().generation) });
    const currentRelease = await f.render('shell.first');
    await oldRelease();
    assert.equal((await f.workspaceMounts())[0]?.mounted, true);
    await currentRelease();
  } finally { await f.close(); }
});

test('旧面板组件模块条目保持语义，工作区只进入挂载概览不冒充旧槽位', async () => {
  const f = await fixture();
  try {
    f.open('shell.first');
    const entries = await f.mounts();
    const legacy = entries.filter((entry) => entry.kind !== 'workspace');
    assert.deepEqual(legacy.map((entry) => entry.kind).sort(), ['component', 'module', 'panel']);
    assert.ok(legacy.every((entry) => entry.mounted === false));
    const component = legacy.find((entry) => entry.kind === 'component');
    const panel = legacy.find((entry) => entry.kind === 'panel');
    assert.equal(component?.slot_id, 'legacy.slot');
    assert.equal(component?.mode, 'append');
    assert.equal(panel?.slot_id, null);
    assert.equal(panel?.evidence, 'host-public-panel-runtime');
    await f.manager.mount('provider', 'provider.panel');
    assert.equal((await f.mounts()).find((entry) => entry.kind === 'panel')?.mounted, true);
    const release = await f.render('shell.first');
    const overview = await f.overview();
    const nodes = records(overview.nodes);
    const workspace = nodes.find((node) => node.kind === 'mount' && record(node.catalog).kind === 'workspace');
    assert.ok(workspace);
    assert.equal(record(workspace.catalog).instance_id, 'shell.first');
    assert.equal(record(workspace.catalog).mounted, true);
    const slots = records((await f.inspect()).slot_catalog);
    assert.equal(slots.length, 1);
    assert.equal(slots[0]?.mounted_by_target, false);
    assert.deepEqual(records(slots[0]?.target_contributions).map((entry) => entry.id), ['provider.component']);
    await release();
  } finally { await f.close(); }
});
