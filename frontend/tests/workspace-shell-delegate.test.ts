import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import type {
  HostContext, WorkspaceMount, WorkspaceViewContext,
} from '../src/plugin-sdk/index.ts';
import type { ShellMountObservation } from '../../examples/workspace-suite/browser/shell-delegate.ts';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((accept) => { resolve = accept; });
  return { promise, resolve };
}
function observation() {
  let current: ShellMountObservation = {
    mount: 'not_observed', mountCount: 0, releaseCount: 0, error: null,
  };
  const history: ShellMountObservation[] = [];
  return {
    snapshot: () => current, history,
    update(change: (value: ShellMountObservation) => ShellMountObservation) {
      current = change(current); history.push(current);
    },
  };
}

async function fixture(unit: TestContext, mount: WorkspaceMount) {
  const parser = registerCompositionStartupImports();
  assert.deepEqual(parser.diagnostics, []);
  const browser = new JSDOM('<!doctype html><html><body></body></html>');
  let network = 0;
  unit.mock.method(globalThis, 'fetch', async () => { network++; throw new Error('此生命周期单元禁止联网'); });
  const { createFrontendRuntime } = await import('../src/app/runtime.ts');
  const { mountShellDelegate } = await import('../../examples/workspace-suite/browser/shell-delegate.ts');
  const runtime = createFrontendRuntime({
    baseUrl: 'http://127.0.0.1:7031', panelTarget: () => null, workspaceStorage: null,
    transport: async () => { network++; throw new Error('此生命周期单元禁止业务请求'); },
  });
  unit.after(async () => {
    try { await runtime.dispose(); }
    finally { parser.dispose(); browser.window.close(); }
  });
  const contexts: HostContext[] = [];
  const provider = 'shell_provider_unit', owner = 'shell_consumer_unit';
  runtime.webPlugins.register({ id: provider, trusted: true, plugin: {
    id: provider, version: '1', apiVersion: 2, panels: [],
    async activate(context) {
      assert.ok(context.ui);
      context.ui.register({ views: [{ id: `${provider}.root`, title: '真实公开外壳视图', provides: ['host.shell'], mount }] });
    },
  } });
  runtime.webPlugins.register({ id: owner, trusted: true, plugin: {
    id: owner, version: '1', apiVersion: 2, panels: [],
    async activate(context) { contexts.push(context); },
  } });
  await runtime.webPlugins.load(provider);
  await runtime.webPlugins.load(owner);
  const context = contexts[0]; assert.ok(context?.ui?.mount);
  const ui = context.ui, parentLifetime = new AbortController();
  unit.after(() => { parentLifetime.abort(); });
  const parentId = `${owner}.parent`, unrelatedId = `${owner}.other`;
  ui.open({ instanceId: parentId, workspaceId: 'host.shell', provider: null, visible: false }, parentLifetime.signal);
  const unrelated = ui.open({ instanceId: unrelatedId, workspaceId: 'host.shell', provider: null,
    target: { draft: '其他实例草稿' } }, context.signal);
  let subscriptions = 0;
  const parent: WorkspaceViewContext = {
    signal: AbortSignal.any([context.signal, parentLifetime.signal]),
    snapshot() {
      const value = ui.snapshot().instances.find((entry) => entry.instanceId === parentId);
      assert.ok(value, '真实父实例必须仍存在'); return value;
    },
    subscribeVisibility(listener) {
      subscriptions++;
      let visible = this.snapshot().visible, active = true;
      const release = ui.subscribe(() => {
        const current = ui.snapshot().instances.find((entry) => entry.instanceId === parentId);
        if (!current || visible === current.visible) return;
        visible = current.visible; listener(visible);
      });
      return async () => {
        if (!active) return;
        active = false; subscriptions--; await release();
      };
    },
  };
  return {
    context, ui, parent, parentId, unrelated, parentLifetime, runtime, mountShellDelegate,
    original: { pluginId: provider, viewId: `${provider}.root` },
    target: () => browser.window.document.createElement('div'),
    instanceId: (suffix: string) => `${owner}.${suffix}`,
    subscriptions: () => subscriptions, network: () => network,
  };
}

test('真实子视图挂载拒绝保留 failed 与原错误，关闭已打开委托但不改变其他实例', async (unit) => {
  const failure = new Error('已进入公开子视图后的真实挂载错误');
  let entered = 0;
  const f = await fixture(unit, async () => { entered++; throw failure; });
  const observed = observation(), target = f.target(), own = new AbortController();
  const instanceId = f.instanceId('failed');
  await assert.rejects(f.mountShellDelegate(target, f.context, f.parent, {
    instanceId, original: f.original, behavior: 'delegate', signal: own.signal, update: observed.update,
  }), (error) => error === failure);
  assert.equal(entered, 1);
  assert.equal(observed.snapshot().mount, 'failed');
  assert.equal(observed.snapshot().error, failure.message);
  assert.equal(observed.snapshot().mountCount, 1);
  assert.equal(observed.snapshot().releaseCount, 1);
  assert.equal(observed.history.some((value) => value.mount === 'ready'), false);
  assert.equal(f.ui.snapshot().instances.some((value) => value.instanceId === instanceId), false);
  const unchanged = f.ui.snapshot().instances.find((value) => value.instanceId === f.unrelated.instanceId);
  assert.equal(unchanged?.generation, f.unrelated.generation);
  assert.deepEqual(unchanged?.target, { draft: '其他实例草稿' });
  assert.equal(f.parent.snapshot().visible, false);
  assert.equal(f.subscriptions(), 0);
  assert.equal(target.childElementCount, 0);
  assert.equal(f.network(), 0);
});

test('真实委托初始继承隐藏状态并同步父可见性，重复释放只回收一次渲染和订阅', async (unit) => {
  let mounts = 0, releases = 0;
  const initialVisibility: boolean[] = [];
  const f = await fixture(unit, async (target, _context, instance) => {
    mounts++; initialVisibility.push(instance.snapshot().visible);
    const input = target.ownerDocument.createElement('input');
    input.value = '原外壳独立草稿'; target.append(input);
    return () => { releases++; input.remove(); };
  });
  const observed = observation(), target = f.target(), own = new AbortController();
  const instanceId = f.instanceId('success');
  const release = await f.mountShellDelegate(target, f.context, f.parent, {
    instanceId, original: f.original, behavior: 'delegate', signal: own.signal, update: observed.update,
  });
  assert.equal(mounts, 1);
  assert.equal(initialVisibility[0], false);
  assert.equal(f.ui.snapshot().instances.find((value) => value.instanceId === instanceId)?.visible, false);
  assert.equal(observed.snapshot().mount, 'ready');
  assert.equal(observed.snapshot().mountCount, 1);
  assert.equal(observed.snapshot().error, null);
  assert.equal(f.subscriptions(), 1);
  const input = target.querySelector('input'); assert.ok(input);
  f.ui.setVisible(f.parentId, true);
  assert.equal(f.ui.snapshot().instances.find((value) => value.instanceId === instanceId)?.visible, true);
  assert.equal(target.querySelector('input') === input, true);
  assert.equal(input.value, '原外壳独立草稿');
  assert.equal(mounts, 1);
  await release(); await release();
  assert.equal(releases, 1);
  assert.equal(observed.snapshot().mount, 'released');
  assert.equal(observed.snapshot().releaseCount, 1);
  assert.equal(f.subscriptions(), 0);
  assert.equal(f.ui.snapshot().instances.some((value) => value.instanceId === instanceId), false);
  assert.equal(f.ui.snapshot().instances.some((value) => value.instanceId === f.unrelated.instanceId), true);
  assert.equal(target.childElementCount, 0);
  assert.equal(f.network(), 0);
});

test('取消后的迟到渲染释放只属于旧调用，不发布 ready 或污染独立新委托及草稿', async (unit) => {
  const entered = deferred(), late = deferred(), lateReleased = deferred();
  let mounts = 0, oldReleases = 0, newReleases = 0;
  const f = await fixture(unit, async (target, _context, instance) => {
    mounts++;
    const id = instance.snapshot().instanceId;
    if (id.endsWith('.old')) {
      entered.resolve();
      await late.promise;
      return () => { oldReleases++; lateReleased.resolve(); };
    }
    const input = target.ownerDocument.createElement('input');
    input.value = '新调用保留草稿'; target.append(input);
    return () => { newReleases++; input.remove(); };
  });
  unit.after(() => { late.resolve(); });
  const old = observation(), oldTarget = f.target(), cancellation = new AbortController();
  const oldId = f.instanceId('old');
  const pending = f.mountShellDelegate(oldTarget, f.context, f.parent, {
    instanceId: oldId, original: f.original, behavior: 'delegate', signal: cancellation.signal, update: old.update,
  });
  const rejected = assert.rejects(pending, (error) => error instanceof Error &&
    ('kind' in error && error.kind === 'cancelled' || error.name === 'AbortError'));
  await entered.promise;
  assert.equal(old.snapshot().mount, 'mounting');
  cancellation.abort();
  await rejected;
  assert.equal(old.history.some((value) => value.mount === 'ready'), false);
  assert.equal(old.snapshot().mount, 'released');
  assert.equal(f.ui.snapshot().instances.some((value) => value.instanceId === oldId), false);
  assert.equal(f.subscriptions(), 0);

  const current = observation(), currentTarget = f.target(), own = new AbortController();
  const currentId = f.instanceId('current');
  const release = await f.mountShellDelegate(currentTarget, f.context, f.parent, {
    instanceId: currentId, original: f.original, behavior: 'delegate', signal: own.signal, update: current.update,
  });
  assert.equal(current.snapshot().mount, 'ready');
  const input = currentTarget.querySelector('input'); assert.ok(input);
  late.resolve();
  await lateReleased.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(oldReleases, 1);
  assert.equal(newReleases, 0);
  assert.equal(mounts, 2);
  assert.equal(old.history.some((value) => value.mount === 'ready'), false);
  assert.equal(current.snapshot().mount, 'ready');
  assert.equal(currentTarget.querySelector('input') === input, true);
  assert.equal(input.value, '新调用保留草稿');
  assert.equal(f.ui.snapshot().instances.some((value) => value.instanceId === currentId), true);
  assert.equal(f.subscriptions(), 1);
  await release(); await release();
  assert.equal(oldReleases, 1);
  assert.equal(newReleases, 1);
  assert.equal(current.snapshot().releaseCount, 1);
  assert.equal(f.subscriptions(), 0);
  assert.equal(oldTarget.childElementCount, 0);
  assert.equal(currentTarget.childElementCount, 0);
  assert.equal(f.network(), 0);
});

test('登记所有者先撤销而调用上下文仍有效时，正常释放不把 owner_revoked 增记为回收失败', async (unit) => {
  const f = await fixture(unit, async () => () => {});
  const { createWorkspaceRegistry } = await import('../src/plugins/workspace/index.ts');
  const { createWorkspaceRendering } = await import('../src/plugins/workspace-rendering.ts');
  const registry = createWorkspaceRegistry(), registryOwner = new AbortController();
  const model = registry.access({ pluginId: 'split_owner_unit', generation: 1, signal: registryOwner.signal });
  const rendering = createWorkspaceRendering(), ui = rendering.access(model);
  unit.after(async () => { try { await rendering.dispose(); } finally { registry.dispose(); } });
  let releases = 0;
  rendering.setRenderer(async (_id, target) => {
    target.append(target.ownerDocument.createElement('input'));
    return () => { releases++; target.replaceChildren(); };
  });
  const context: HostContext = { ...f.context, ui };
  const observed = observation(), target = f.target(), cancellation = new AbortController();
  const release = await f.mountShellDelegate(target, context, f.parent, {
    instanceId: 'split_owner_unit.delegate', original: f.original, behavior: 'delegate',
    signal: cancellation.signal, update: observed.update,
  });
  assert.equal(target.childElementCount, 1);
  registryOwner.abort();
  assert.equal(context.signal.aborted, false);
  assert.throws(() => ui.snapshot(), (error) => error instanceof Error && 'kind' in error &&
    error.kind === 'cancelled' && 'code' in error && error.code === 'workspace_owner_revoked');
  await release();
  assert.equal(releases, 1);
  assert.equal(observed.snapshot().mount, 'released');
  assert.equal(observed.snapshot().releaseCount, 1);
  assert.equal(target.childElementCount, 0);
  assert.equal(f.subscriptions(), 0);
  assert.equal(context.signal.aborted, false);
  assert.equal(f.network(), 0);
});

test('关闭前 snapshot 的其他真实异常仍以原原因失败，渲染与可见性仍回收', async (unit) => {
  let releases = 0;
  const f = await fixture(unit, async () => () => { releases++; });
  const failure = new Error('真实快照读取失败');
  let broken = false;
  const context: HostContext = { ...f.context, ui: { ...f.ui,
    snapshot() { if (broken) throw failure; return f.ui.snapshot(); },
  } };
  const observed = observation(), target = f.target(), own = new AbortController();
  const release = await f.mountShellDelegate(target, context, f.parent, {
    instanceId: f.instanceId('snapshot_failure'), original: f.original, behavior: 'delegate',
    signal: own.signal, update: observed.update,
  });
  broken = true;
  await assert.rejects(Promise.resolve().then(release),
    (error: unknown) => error instanceof AggregateError && error.errors.includes(failure));
  assert.equal(releases, 1);
  assert.equal(f.subscriptions(), 0);
  assert.equal(target.childElementCount, 0);
  assert.equal(f.network(), 0);
});

test('close 的其他真实异常仍以原原因失败，不因正常取消例外吞掉错误', async (unit) => {
  let releases = 0;
  const f = await fixture(unit, async () => () => { releases++; });
  const failure = { kind: 'protocol', code: 'workspace_owner_revoked', message: '同名但不是取消的真实关闭失败' };
  const context: HostContext = { ...f.context, ui: { ...f.ui, close() { throw failure; } } };
  const observed = observation(), target = f.target(), own = new AbortController();
  const release = await f.mountShellDelegate(target, context, f.parent, {
    instanceId: f.instanceId('close_failure'), original: f.original, behavior: 'delegate',
    signal: own.signal, update: observed.update,
  });
  await assert.rejects(Promise.resolve().then(release),
    (error: unknown) => error instanceof AggregateError && error.errors.includes(failure));
  assert.equal(releases, 1);
  assert.equal(f.subscriptions(), 0);
  assert.equal(target.childElementCount, 0);
  assert.equal(f.network(), 0);
});
