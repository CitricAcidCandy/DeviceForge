import assert from 'node:assert/strict';
import test from 'node:test';
import type { Dispose, HostContext } from '../src/plugin-sdk/index.ts';
import type { WorkspaceMount } from '../src/plugin-sdk/workspace.ts';
import { createWorkspaceRegistry } from '../src/plugins/workspace/index.ts';
import { createWorkspaceMounts } from '../src/plugins/workspace-mounts.ts';
import { createPluginScope } from '../src/plugins/scope.ts';
import { children, dom } from './dom-fixtures.ts';
import { deferred } from './fixtures.ts';

const forever = () => new Promise<never>(() => undefined);
function fixture(mount: WorkspaceMount, timeouts = { mountMs: 100, cleanupMs: 30 }) {
  const registry = createWorkspaceRegistry();
  const provider = createPluginScope({
    apiVersion: 2, signal: new AbortController().signal,
    listOperations: async () => ({ data: [], logId: null }),
    submit: forever, getJob: forever, cancelJob: forever,
    subscribeOperations: () => () => {}, onDispose: (dispose: Dispose) => dispose,
  });
  const ui = registry.access({ pluginId: 'plugin', generation: 1, signal: provider.context.signal }, provider.track);
  ui.register({ views: [{ id: 'plugin.view', title: '工作区视图', mount }] });
  const bridge = createWorkspaceMounts({
    registry, timeouts,
    contextFor: (pluginId, generation) => pluginId === 'plugin' && generation === 1 ? provider.context : null,
  });
  const open = (instanceId: string, target: string = instanceId) => ui.open({
    instanceId, workspaceId: 'plugin.work', provider: { pluginId: 'plugin', viewId: 'plugin.view' }, target,
  });
  return { registry, provider, ui, bridge, open };
}

test('工作区挂载根传递容器尺寸，不以内容高度截断外壳或修改外部目标', async () => {
  const f = fixture(async (root) => {
    const content = root.ownerDocument.createElement('div');
    content.className = 'h-full min-h-0 min-w-0 w-full';
    root.append(content);
    return () => {};
  });
  const target = dom();
  target.className = 'relative h-full min-h-0 w-full';
  f.open('plugin.shell');
  try {
    await f.bridge.mount('plugin.shell', target);
    const root = children(target)[0];
    assert.ok(root);
    for (const name of ['h-full', 'w-full', 'min-h-0', 'min-w-0']) {
      assert.equal(root.classList.contains(name), true, `工作区挂载根缺少 ${name}`);
    }
    assert.equal(root.style.length, 0);
    assert.equal(target.className, 'relative h-full min-h-0 w-full');
  } finally {
    await f.bridge.dispose();
    await f.provider.dispose();
    f.registry.dispose();
  }
});

test('同一视图的两个实例独立挂载，保留fallback并标注实例与视图归属', async () => {
  const received: string[] = [];
  const f = fixture(async (root, _context, instance) => {
    received.push(instance.snapshot().instanceId);
    root.textContent = String(instance.snapshot().target);
    return () => {};
  });
  f.open('plugin.a', 'A'); f.open('plugin.b', 'B');
  const target = dom();
  const fallback = target.ownerDocument.createElement('div');
  fallback.textContent = 'fallback'; target.append(fallback);
  await Promise.all([f.bridge.mount('plugin.a', target), f.bridge.mount('plugin.b', target)]);
  assert.deepEqual(received.sort(), ['plugin.a', 'plugin.b']);
  assert.equal(children(target).length, 3);
  assert.equal(fallback.hidden, false);
  assert.equal(children(target)[1]?.dataset.deviceforgeWorkspaceInstance, 'plugin.a');
  assert.equal(children(target)[1]?.dataset.deviceforgeWorkspaceView, 'plugin.view');
  assert.equal(f.bridge.has('plugin.a'), true);
  await f.bridge.unmount('plugin.a');
  assert.equal(f.bridge.has('plugin.a'), false);
  assert.equal(f.bridge.has('plugin.b'), true);
  assert.equal(target.textContent, 'fallbackB');
  await f.bridge.dispose();
  await f.provider.dispose(); f.registry.dispose();
});

test('目标换代同步撤销旧DOM，不自动重挂；晚到释放只属于旧scope', { timeout: 2000 }, async () => {
  const late = deferred<Dispose>();
  const entered = deferred<void>();
  let calls = 0;
  let oldReleased = 0;
  let oldContext: HostContext | undefined;
  const f = fixture(async (root, context, instance) => {
    calls++;
    root.textContent = String(instance.snapshot().target);
    if (calls === 1) { oldContext = context; entered.resolve(); return late.promise; }
    return () => {};
  }, { mountMs: 1000, cleanupMs: 30 });
  f.open('plugin.a', 'old');
  const target = dom();
  const pending = assert.rejects(f.bridge.mount('plugin.a', target), /撤销/);
  await entered.promise;
  f.ui.setTarget('plugin.a', 'new');
  assert.equal(oldContext?.signal.aborted, true);
  assert.equal(target.children.length, 0);
  await pending;
  assert.equal(calls, 1);
  await f.bridge.mount('plugin.a', target);
  late.resolve(() => { oldReleased++; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(oldReleased, 1);
  assert.equal(target.textContent, 'new');
  assert.equal(f.bridge.has('plugin.a'), true);
  await f.bridge.dispose(); await f.provider.dispose(); f.registry.dispose();
});

test('永不返回挂载有界回滚，不阻塞另一个实例或后续同实例挂载', { timeout: 2000 }, async () => {
  let first = true;
  const entered = deferred<void>();
  const f = fixture(async (root, _context, instance) => {
    root.textContent = instance.snapshot().instanceId;
    if (first) { first = false; entered.resolve(); return forever(); }
    return () => {};
  }, { mountMs: 35, cleanupMs: 25 });
  f.open('plugin.a'); f.open('plugin.b');
  const a = dom(), b = dom();
  const pending = assert.rejects(f.bridge.mount('plugin.a', a), /期限/);
  await entered.promise;
  await f.bridge.mount('plugin.b', b);
  assert.equal(f.bridge.has('plugin.b'), true);
  await pending;
  assert.equal(a.children.length, 0);
  await f.bridge.mount('plugin.a', a);
  assert.equal(f.bridge.has('plugin.a'), true);
  await f.bridge.dispose(); await f.provider.dispose(); f.registry.dispose();
});

test('永不返回清理有界保留诊断，新成功不清除旧失败且不冻结新实例', { timeout: 2000 }, async () => {
  let cleanupStuck = true;
  const f = fixture(async (root) => {
    root.textContent = 'live';
    if (cleanupStuck) { cleanupStuck = false; return forever; }
    return () => {};
  }, { mountMs: 100, cleanupMs: 25 });
  f.open('plugin.a'); f.open('plugin.b');
  const target = dom();
  await f.bridge.mount('plugin.a', target);
  const pending = assert.rejects(f.bridge.unmount('plugin.a'), /期限|超时/);
  assert.equal(target.children.length, 0);
  await f.bridge.mount('plugin.b', target);
  await pending;
  assert.equal(f.bridge.cleanupSnapshot().length, 1);
  await f.bridge.mount('plugin.a', target);
  assert.equal(f.bridge.has('plugin.a'), true);
  assert.equal(f.bridge.cleanupSnapshot().length, 1);
  await f.bridge.dispose(); await f.provider.dispose(); f.registry.dispose();
});

test('隐藏仅通知模型可见性，外部取消与提供者撤销同步移除各自DOM', async () => {
  const visible: boolean[] = [];
  let mountCalls = 0;
  const f = fixture(async (_root, context, instance) => {
    mountCalls++;
    context.onDispose(instance.subscribeVisibility((value) => visible.push(value)));
    return () => {};
  });
  f.open('plugin.a'); f.open('plugin.b');
  const target = dom();
  const controller = new AbortController();
  await f.bridge.mount('plugin.a', target, controller.signal);
  await f.bridge.mount('plugin.b', target);
  f.ui.setVisible('plugin.a', false);
  assert.deepEqual(visible, [false]);
  assert.equal(target.children.length, 2);
  assert.equal(f.bridge.has('plugin.a'), true);
  controller.abort();
  assert.equal(target.children.length, 1);
  assert.equal(f.bridge.has('plugin.a'), false);
  assert.equal(f.bridge.has('plugin.b'), true);
  f.provider.close();
  assert.equal(target.children.length, 0);
  assert.equal(mountCalls, 2);
  await f.bridge.dispose(); await f.provider.dispose(); f.registry.dispose();
});

test('上下文缺失或已撤销不进入挂载，关闭桥撤销排队调用', async () => {
  const registry = createWorkspaceRegistry();
  const signal = new AbortController();
  const ui = registry.access({ pluginId: 'plugin', generation: 1, signal: signal.signal });
  let called = false;
  ui.register({ views: [{ id: 'plugin.view', title: '视图', mount: async () => { called = true; return () => {}; } }] });
  ui.open({ instanceId: 'plugin.a', workspaceId: 'plugin.work', provider: { pluginId: 'plugin', viewId: 'plugin.view' } });
  const bridge = createWorkspaceMounts({ registry, contextFor: () => null });
  const target = dom();
  await assert.rejects(bridge.mount('plugin.a', target), /上下文/);
  assert.equal(called, false);
  assert.equal(target.children.length, 0);
  await bridge.dispose();
  await assert.rejects(bridge.mount('plugin.a', target), /撤销/);
  registry.dispose();
});

test('排队请求被unmount或根dispose撤销后不能进入插件挂载', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return () => {}; });
  f.open('plugin.a');
  const target = dom();
  const first = assert.rejects(f.bridge.mount('plugin.a', target), /撤销/);
  await f.bridge.unmount('plugin.a');
  await first;
  assert.equal(calls, 0);
  const second = assert.rejects(f.bridge.mount('plugin.a', target), /撤销/);
  await f.bridge.dispose();
  await second;
  assert.equal(calls, 0);
  assert.equal(target.children.length, 0);
  await f.provider.dispose(); f.registry.dispose();
});

test('根dispose在插件清理永不返回时有界失败，DOM同步退出且诊断保留', { timeout: 2000 }, async () => {
  const f = fixture(async () => forever, { mountMs: 100, cleanupMs: 25 });
  f.open('plugin.a');
  const target = dom();
  await f.bridge.mount('plugin.a', target);
  const pending = f.bridge.dispose();
  assert.equal(target.children.length, 0);
  assert.equal(f.bridge.has('plugin.a'), false);
  await assert.rejects(pending, /回收不完整/);
  assert.equal(f.bridge.cleanupSnapshot()[0]?.instanceId, 'plugin.a');
  assert.equal(f.bridge.dispose(), pending);
  await f.provider.dispose(); f.registry.dispose();
});

test('公开release绑定旧Binding，目标换代后的新DOM不会被旧release拆除', async () => {
  let releases = 0;
  const f = fixture(async (root, _context, instance) => {
    root.textContent = String(instance.snapshot().target);
    return () => { releases++; };
  });
  f.open('plugin.a', 'old');
  const target = dom();
  const oldRelease = await f.bridge.mount('plugin.a', target);
  f.ui.setTarget('plugin.a', 'new');
  const newRelease = await f.bridge.mount('plugin.a', target);
  await oldRelease(); await oldRelease();
  assert.equal(target.textContent, 'new');
  assert.equal(f.bridge.has('plugin.a'), true);
  assert.equal(releases, 1);
  await newRelease(); await newRelease();
  assert.equal(target.children.length, 0);
  assert.equal(releases, 2);
  await f.bridge.dispose(); await f.provider.dispose(); f.registry.dispose();
});
