import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { HostError } from '../src/plugin-sdk/index.ts';
import type { Dispose, HostContext, JsonValue } from '../src/plugin-sdk/index.ts';
import { createLocalDebugger } from '../src/app/debugger-local/index.ts';
import type { LocalDebugger } from '../src/app/debugger-local/index.ts';
import { createExtensionRegistry } from '../src/plugins/extensions/registry.ts';
import { createPluginManager } from '../src/plugins/manager.ts';
import { createPortalOwnership } from '../src/app/portal-ownership.ts';

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}
function records(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value));
  return value.map(record);
}
function string(value: unknown): string {
  assert.ok(typeof value === 'string');
  return value;
}
function reference(value: Record<string, unknown>) {
  assert.ok(typeof value.generation === 'number');
  assert.ok(typeof value.revision === 'number');
  return { id: string(value.id), generation: value.generation, revision: value.revision };
}
function host(signal: AbortSignal): HostContext {
  const unavailable = async (): Promise<never> => { throw new Error('Portal 观测单元不得执行业务请求'); };
  return {
    apiVersion: 2, signal, listOperations: async () => ({ data: [], logId: null }),
    submit: unavailable, getJob: unavailable, cancelJob: unavailable,
    subscribeOperations: () => () => {}, onDispose: (value) => value,
  };
}
function code(expected: string) {
  return (error: unknown) => error instanceof HostError && error.code === `debugger_${expected}`;
}
function portal(document: Document, title: string) {
  const element = document.createElement('section');
  element.setAttribute('role', 'dialog');
  element.setAttribute('aria-label', title);
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = `${title}操作`;
  element.append(button);
  document.body.append(element);
  return { element, button };
}
async function fixture() {
  const dom = new JSDOM('<main></main><aside></aside>');
  const document = dom.window.document;
  const main = document.querySelector('main'), aside = document.querySelector('aside');
  assert.ok(main && aside);
  main.setAttribute('data-deviceforge-slot', 'legacy.slot');
  const lifetime = new AbortController(), extensions = createExtensionRegistry();
  let local: LocalDebugger | undefined;
  const manager = createPluginManager({
    host: host(lifetime.signal), extensionRegistry: extensions,
    panelTarget: () => aside, componentTarget: () => main,
    debugForPlugin(pluginId, generation, scope) {
      assert.ok(local);
      return local.attach(pluginId, String(generation), scope);
    },
  });
  local = createLocalDebugger({
    document, signal: lifetime.signal, manager: () => manager, extensions,
    slots: [{ id: 'legacy.slot', label: '旧槽位', modes: ['append'], description: '保留旧组件观测语义' }],
  });
  const debuggerLocal = local;
  const mount = async (root: HTMLElement): Promise<Dispose> => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '来源中的本地动作';
    button.setAttribute('data-deviceforge-action', 'local');
    root.append(button);
    return () => {};
  };
  for (const id of ['provider', 'foreign']) {
    manager.register({ id, trusted: true, plugin: {
      id, apiVersion: 2, version: '1',
      panels: [{ id: `${id}.panel`, title: '来源面板', mount }],
      contributions: { components: [{ id: `${id}.extension`, title: '来源组件', slot: 'legacy.slot', mount }] },
    } });
  }
  const current = await manager.load('provider');
  const other = await manager.load('foreign');
  const target = { plugin_id: 'provider', generation: String(current.generation) };
  debuggerLocal.select([target]);
  await manager.mount('provider', 'provider.panel');
  await manager.mountComponent('provider.extension');
  const panel = aside.querySelector<HTMLElement>('[data-deviceforge-panel="provider.panel"]');
  const extension = main.querySelector<HTMLElement>('[data-deviceforge-extension="provider.extension"]');
  assert.ok(panel && extension);
  const execute = (tool: string, parameters: JsonValue = {}) =>
    debuggerLocal.execute(tool, target, parameters, lifetime.signal);
  const inspect = async () => record(await execute('inspect'));
  const roots = async () => records((await inspect()).roots);
  return {
    dom, document, main, aside, panel, extension, target, manager, extensions,
    foreignGeneration: String(other.generation), execute, inspect, roots,
    async close() {
      debuggerLocal.dispose();
      await manager.dispose();
      await extensions.dispose();
      lifetime.abort();
      dom.window.close();
    },
  };
}

test('既有面板、扩展与无Portal标记的显式外部surface继续可观测', async () => {
  const f = await fixture();
  try {
    const surface = f.document.createElement('section');
    surface.setAttribute('data-deviceforge-plugin', f.target.plugin_id);
    surface.setAttribute('data-deviceforge-generation', f.target.generation);
    surface.setAttribute('data-deviceforge-extension', 'provider.explicit-surface');
    surface.setAttribute('aria-label', '既有显式外部表面');
    f.document.body.append(surface);
    const roots = await f.roots();
    assert.deepEqual(roots.map((root) => root.contribution_id).sort(),
      ['provider.explicit-surface', 'provider.extension', 'provider.panel']);
    assert.equal(roots.find((root) => root.contribution_id === 'provider.panel')?.kind, 'panel');
    assert.equal(roots.find((root) => root.contribution_id === 'provider.explicit-surface')?.kind, 'surface');
    const slots = records((await f.inspect()).slot_catalog);
    assert.equal(slots[0]?.mounted_by_target, true);
    assert.equal(slots[0]?.instantiated, true);
    assert.equal(records((await f.inspect()).mount_catalog).some((entry) => entry.kind === 'workspace'), false);
  } finally { await f.close(); }
});

test('Portal标记未绑定宿主来源时即便同插件同代次也不认领', async () => {
  const f = await fixture();
  try {
    for (const attribute of ['data-deviceforge-extension', 'data-deviceforge-panel']) {
      const portal = f.document.createElement('section');
      portal.setAttribute('data-deviceforge-plugin', f.target.plugin_id);
      portal.setAttribute('data-deviceforge-generation', f.target.generation);
      portal.setAttribute(attribute, `provider.unbound-${attribute}`);
      portal.setAttribute('data-deviceforge-portal', '');
      portal.setAttribute('role', 'dialog');
      portal.setAttribute('aria-label', '仅有标记的未绑定弹窗');
      f.document.body.append(portal);
    }
    const roots = await f.roots();
    assert.deepEqual(roots.map((root) => root.contribution_id).sort(), ['provider.extension', 'provider.panel']);
    const tree = record(await f.execute('ui_tree'));
    assert.equal(tree.status, 'root_required');
    assert.equal(records(tree.roots).length, 2);
  } finally { await f.close(); }
});

test('有效绑定Portal只作为本贡献surface，另一插件、旧代和嵌套提供者均不串归属', async () => {
  const f = await fixture();
  const ownerships: ReturnType<typeof createPortalOwnership>[] = [];
  try {
    const child = f.document.createElement('div');
    f.panel.append(child);
    const own = createPortalOwnership(child);
    ownerships.push(own);
    const dialog = portal(f.document, '本插件确认弹窗');
    own.register(dialog.element);
    await f.manager.mount('foreign', 'foreign.panel');
    const foreignSource = f.aside.querySelector<HTMLElement>('[data-deviceforge-panel="foreign.panel"]');
    assert.ok(foreignSource);
    const foreign = createPortalOwnership(foreignSource);
    ownerships.push(foreign);
    const foreignDialog = portal(f.document, '其他插件确认弹窗');
    foreign.register(foreignDialog.element);
    const nested = f.document.createElement('div');
    nested.setAttribute('data-deviceforge-plugin', 'foreign');
    nested.setAttribute('data-deviceforge-generation', f.foreignGeneration);
    nested.setAttribute('data-deviceforge-extension', 'foreign.nested');
    const privateButton = f.document.createElement('button');
    privateButton.textContent = '内层其他提供者动作';
    nested.append(privateButton);
    dialog.element.append(nested);
    const inner = createPortalOwnership(nested);
    ownerships.push(inner);
    inner.register(portal(f.document, '嵌套其他提供者弹窗').element);
    const staleSource = f.document.createElement('div');
    for (const attribute of f.extension.attributes) staleSource.setAttribute(attribute.name, attribute.value);
    staleSource.setAttribute('data-deviceforge-generation', String(Number(f.target.generation) + 10));
    f.main.append(staleSource);
    const stale = createPortalOwnership(staleSource);
    ownerships.push(stale);
    stale.register(portal(f.document, '旧代来源弹窗').element);
    const evidence = await f.inspect();
    const roots = records(evidence.roots);
    assert.equal(roots.length, 3);
    const observed = roots.find((entry) => entry.contribution_id === dialog.element.getAttribute('data-deviceforge-extension'));
    assert.ok(observed);
    assert.equal(observed.kind, 'surface');
    const tree = record(record(await f.execute('ui_tree', { root_id: string(observed.root_id) })).tree);
    const nodes = records(tree.nodes);
    assert.ok(nodes.some((node) => node.role === 'dialog' && node.name === '本插件确认弹窗'));
    assert.ok(nodes.some((node) => node.kind === 'surface' && node.surfaceId === observed.contribution_id));
    assert.ok(nodes.every((node) => record(node.owner).pluginId === f.target.plugin_id));
    assert.equal(JSON.stringify(nodes).includes('内层其他提供者动作'), false);
    assert.equal(record(tree.coverage).excludedPluginRoots, 1);
    assert.equal(records(evidence.mount_catalog).some((entry) => entry.id === observed.contribution_id), false);
    assert.equal(records(evidence.mount_catalog).some((entry) => entry.kind === 'workspace'), false);
    assert.equal(records(evidence.slot_catalog)[0]?.mounted_by_target, true);
  } finally {
    for (const ownership of ownerships) ownership.dispose();
    await f.close();
  }
});

test('Portal来源贡献变更、断开或进入调试器内部后撤销，移除marker也不能降级认领', async () => {
  const f = await fixture();
  const ownerships: ReturnType<typeof createPortalOwnership>[] = [];
  try {
    for (const change of ['contribution', 'disconnected', 'internal', 'disposed']) {
      const source = f.document.createElement('div');
      source.setAttribute('data-deviceforge-plugin', f.target.plugin_id);
      source.setAttribute('data-deviceforge-generation', f.target.generation);
      source.setAttribute('data-deviceforge-extension', `provider.source-${change}`);
      f.main.append(source);
      const ownership = createPortalOwnership(source);
      ownerships.push(ownership);
      const dialog = portal(f.document, `来源失效-${change}`);
      ownership.register(dialog.element);
      const contribution = dialog.element.getAttribute('data-deviceforge-extension');
      assert.ok((await f.roots()).some((root) => root.contribution_id === contribution));
      if (change === 'contribution') source.setAttribute('data-deviceforge-extension', 'provider.changed-contribution');
      else if (change === 'disconnected') source.remove();
      else if (change === 'internal') {
        const internal = f.document.createElement('div');
        internal.setAttribute('data-deviceforge-debugger-internal', '');
        f.main.append(internal);
        internal.append(source);
      } else ownership.dispose();
      assert.equal((await f.roots()).some((root) => root.contribution_id === contribution), false);
      dialog.element.removeAttribute('data-deviceforge-portal');
      dialog.element.setAttribute('data-deviceforge-plugin', f.target.plugin_id);
      dialog.element.setAttribute('data-deviceforge-generation', f.target.generation);
      dialog.element.setAttribute('data-deviceforge-extension', string(contribution));
      assert.equal((await f.roots()).some((root) => root.contribution_id === contribution), false);
    }
    const internal = f.document.createElement('div');
    internal.setAttribute('data-deviceforge-debugger-internal', '');
    f.main.append(internal);
    internal.append(f.extension);
    const hidden = createPortalOwnership(f.extension);
    ownerships.push(hidden);
    const dialog = portal(f.document, '调试器内部来源');
    hidden.register(dialog.element);
    assert.equal(dialog.element.hasAttribute('data-deviceforge-plugin'), false);
    assert.equal((await f.roots()).some((root) => root.contribution_id === 'provider.extension'), false);
  } finally {
    for (const ownership of ownerships) ownership.dispose();
    await f.close();
  }
});

test('Portal动作保留未知副作用及写入确认，源卸载回收collector并拒绝旧节点', async (unit) => {
  const f = await fixture();
  const ownership = createPortalOwnership(f.panel);
  try {
    const dialog = portal(f.document, '卸载确认');
    ownership.register(dialog.element);
    let clicks = 0, disconnected = 0;
    dialog.button.addEventListener('click', () => { clicks++; });
    const original = f.dom.window.MutationObserver.prototype.disconnect;
    unit.mock.method(f.dom.window.MutationObserver.prototype, 'disconnect', function (this: MutationObserver) {
      disconnected++;
      original.call(this);
    });
    const root = (await f.roots()).find((entry) =>
      entry.contribution_id === dialog.element.getAttribute('data-deviceforge-extension'));
    assert.ok(root);
    const rootId = string(root.root_id);
    const tree = record(record(await f.execute('ui_tree', { root_id: rootId })).tree);
    const button = records(tree.nodes).find((node) => node.role === 'button' && node.name === '卸载确认操作');
    assert.ok(button);
    const target = reference(button);
    const click = async (confirmed: boolean, allowUnknownSideEffects: boolean) => record(await f.execute('ui_action', {
      root_id: rootId, action: { type: 'click', target, confirmed, allowUnknownSideEffects },
    }));
    assert.equal((await click(false, false)).status, 'rejected');
    const unknown = await click(true, false);
    assert.equal(unknown.status, 'rejected');
    assert.match(string(unknown.reason), /副作用未知/);
    const unconfirmed = await click(false, true);
    assert.equal(unconfirmed.status, 'rejected');
    assert.match(string(unconfirmed.reason), /显式确认/);
    assert.equal(clicks, 0);
    const dispatched = await click(true, true);
    assert.equal(dispatched.status, 'dispatched');
    assert.equal(dispatched.businessOutcome, 'unknown');
    assert.equal(clicks, 1);
    assert.equal(record(await f.execute('ui_action', {
      root_id: rootId, action: { type: 'highlight', target },
    })).status, 'applied');
    assert.equal(dialog.button.classList.contains('outline-2'), true);
    await f.manager.unmount('provider', 'provider.panel');
    assert.equal(dialog.element.isConnected, true);
    assert.equal((await f.roots()).some((entry) => entry.root_id === rootId), false);
    assert.equal(disconnected, 1);
    assert.equal(dialog.button.classList.contains('outline-2'), false);
    await assert.rejects(click(true, true), code('root_unavailable'));
    assert.equal(clicks, 1);
    const remaining = (await f.roots()).find((entry) => entry.contribution_id === 'provider.extension');
    assert.ok(remaining);
    const next = record(record(await f.execute('ui_tree', { root_id: string(remaining.root_id) })).tree);
    assert.ok(records(next.nodes).some((node) => node.name === '来源中的本地动作'));
  } finally {
    ownership.dispose();
    await f.close();
  }
});

test('Portal沿用64根和16个collector上限，撤销只回收本根容量', async () => {
  const f = await fixture();
  const ownership = createPortalOwnership(f.panel);
  const dialogs: HTMLElement[] = [];
  try {
    for (let index = 0; index < 63; index++) {
      const dialog = portal(f.document, `容量测试弹窗${index}`);
      dialogs.push(dialog.element);
      ownership.register(dialog.element);
    }
    await assert.rejects(f.inspect(), code('limit_exceeded'));
    dialogs.at(-1)?.remove();
    dialogs.at(-2)?.remove();
    const roots = await f.roots();
    assert.equal(roots.length, 63);
    const portals = roots.filter((root) => string(root.contribution_id).startsWith('provider.panel.portal.'));
    assert.equal(portals.length, 61);
    for (const root of portals.slice(0, 16)) await f.execute('ui_tree', { root_id: string(root.root_id) });
    const next = portals[16], retired = portals[0];
    assert.ok(next && retired);
    await assert.rejects(f.execute('ui_tree', { root_id: string(next.root_id) }), code('limit_exceeded'));
    dialogs[0]?.remove();
    assert.equal((await f.roots()).some((root) => root.root_id === retired.root_id), false);
    const tree = record(record(await f.execute('ui_tree', { root_id: string(next.root_id) })).tree);
    assert.ok(records(tree.nodes).length > 0);
  } finally {
    ownership.dispose();
    await f.close();
  }
});
