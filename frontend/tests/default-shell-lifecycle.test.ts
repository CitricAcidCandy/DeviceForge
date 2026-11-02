import assert from 'node:assert/strict';
import test from 'node:test';
import { HostError } from '../src/plugin-sdk/index.ts';
import type { Dispose, HostContext, UiAccess, WorkspaceMount } from '../src/plugin-sdk/index.ts';
import { createWorkspaceRegistry } from '../src/plugins/workspace/index.ts';
import { createMountPool } from '../plugins/default-shell/src/mount-pool.ts';
import { createShellController } from '../plugins/default-shell/src/controller.ts';
import { dom } from './dom-fixtures.ts';
import { deferred } from './fixtures.ts';

const forever = () => new Promise<never>(() => undefined);
const mount: WorkspaceMount = async () => () => {};
function fixture(render?: NonNullable<UiAccess['mount']>) {
  const target = dom(), document = target.ownerDocument;
  const registry = createWorkspaceRegistry();
  const owner = new AbortController();
  const plugin = new AbortController();
  const business = registry.access({ pluginId: 'business', generation: 1, signal: plugin.signal });
  business.register({
    pages: [
      { id: 'business.device', title: '设备', route: '/devices', mount, navigation: { order: 1, group: '工作台' } },
      { id: 'business.file', title: '文件', route: '/files', mount, navigation: { order: 2, group: '工作台' } },
    ],
    views: [{ id: 'business.alternative', title: '另一个视图', mount }],
  });
  let calls = 0, releases = 0;
  const ui: UiAccess = {
    ...registry.access({ pluginId: 'deviceforge_shell', generation: 1, signal: owner.signal }),
    mount: render ?? (async (_id, root) => {
      calls++;
      const input = document.createElement('input');
      root.append(input);
      return () => { releases++; input.remove(); };
    }),
  };
  const pool = createMountPool(ui, document, owner.signal);
  const context: HostContext = {
    apiVersion: 2, ui, signal: owner.signal,
    listOperations: async () => ({ data: [], logId: null }),
    submit: forever, getJob: forever, cancelJob: forever,
    subscribeOperations: () => () => {}, onDispose: (release: Dispose) => release,
  };
  const controller = createShellController(context, pool, '/devices');
  const cleanup = async () => { controller.dispose(); await pool.dispose(); registry.dispose(); };
  return { target, document, registry, owner, plugin, business, ui, pool, controller, cleanup, counts: () => ({ calls, releases }) };
}

test('动态页面无需固定路由清单，跨页隐藏保持DOM与输入草稿，不重复mount', async () => {
  const f = fixture();
  const first = f.controller.snapshot().model.instances[0];
  assert.ok(first);
  const slot = f.document.createElement('div');
  const detach = f.pool.attach(first.instanceId, slot);
  await f.pool.prepare(first.instanceId);
  const input = slot.querySelector('input');
  assert.ok(input);
  input.value = '未保存草稿';
  f.controller.navigate('/files');
  assert.equal(f.ui.snapshot().instances.find((view) => view.instanceId === first.instanceId)?.visible, false);
  await detach();
  f.controller.navigate('/devices');
  const nextSlot = f.document.createElement('div');
  f.pool.attach(first.instanceId, nextSlot);
  await f.pool.prepare(first.instanceId);
  assert.equal(nextSlot.querySelector('input'), input);
  assert.equal(input.value, '未保存草稿');
  assert.equal(f.counts().calls, 1);
  assert.equal(f.controller.snapshot().visited.length, 2);
  await f.cleanup();
  assert.equal(f.counts().releases, 1);
});

test('候选提供者准备失败保留原布局与实例，成功后才提交替换', async () => {
  const gate = deferred<Dispose>(), entered = deferred<void>();
  let fail = true;
  const f = fixture(async () => {
    if (fail) throw new Error('候选视图失败');
    entered.resolve();
    return gate.promise;
  });
  const original = f.controller.snapshot().model.instances[0];
  assert.ok(original);
  const layout = f.ui.readLayout(original.workspaceId);
  const ref = { pluginId: 'business', viewId: 'business.alternative' };
  await assert.rejects(f.controller.replace(original.instanceId, ref), /候选视图失败/);
  assert.deepEqual(f.ui.readLayout(original.workspaceId), layout);
  assert.ok(f.ui.snapshot().instances.some((view) => view.instanceId === original.instanceId));
  fail = false;
  const pending = f.controller.replace(original.instanceId, ref);
  await entered.promise;
  assert.deepEqual(f.ui.readLayout(original.workspaceId), layout);
  assert.ok(f.ui.snapshot().instances.some((view) => view.instanceId === original.instanceId));
  gate.resolve(() => {});
  const id = await pending;
  assert.deepEqual(f.ui.readLayout(original.workspaceId)?.root, { kind: 'view', instanceId: id });
  assert.equal(f.ui.snapshot().instances.some((view) => view.instanceId === original.instanceId), false);
  await f.cleanup();
});

test('关闭视图不卸载插件也不自动重开，业务停用保留已访问页及布局', async () => {
  const f = fixture();
  const original = f.controller.snapshot().model.instances[0];
  assert.ok(original);
  f.controller.close(original.instanceId);
  assert.equal(f.ui.readLayout(original.workspaceId)?.root, null);
  f.controller.navigate('/files'); f.controller.navigate('/devices');
  assert.equal(f.ui.snapshot().instances.some((view) => view.instanceId === original.instanceId), false);
  f.plugin.abort();
  assert.equal(f.controller.snapshot().current?.page.title, '设备');
  assert.equal(f.controller.snapshot().available, false);
  assert.ok(f.ui.readLayout(original.workspaceId));
  await f.cleanup();
});

test('窄窗只改变显示与可见性，不新建或重挂实例', async () => {
  const f = fixture();
  await f.controller.add({ pluginId: 'business', viewId: 'business.alternative' }, 'split');
  const before = f.ui.snapshot().instances;
  f.controller.setCompact(true);
  const current = f.controller.snapshot();
  assert.equal(current.model.instances.length, before.length);
  assert.equal(current.model.instances.filter((view) => view.visible).length, 1);
  const other = current.model.instances.find((view) => view.instanceId !== current.compactView);
  assert.ok(other);
  f.controller.selectCompact(other.instanceId);
  assert.equal(f.ui.snapshot().instances.find((view) => view.visible)?.instanceId, other.instanceId);
  f.controller.setCompact(false);
  assert.equal(f.ui.snapshot().instances.filter((view) => view.visible).length, 2);
  await f.cleanup();
});

test('提供者loaded通知只补旧宿主明确的早期拒绝，已就绪视图与草稿保持', async () => {
  let loaded = false, calls = 0, releases = 0;
  const f = fixture(async (_id, target) => {
    calls++;
    if (!loaded) throw new HostError('cancelled', 'workspace_provider_revoked', '提供者尚未完成加载');
    target.textContent = '真实视图';
    return () => { releases++; target.textContent = ''; };
  });
  const instance = f.ui.snapshot().instances[0];
  assert.ok(instance);
  const slot = f.document.createElement('div');
  f.pool.attach(instance.instanceId, slot);
  await assert.rejects(f.pool.prepare(instance.instanceId), /尚未完成/);
  loaded = true;
  f.pool.providerLoaded('business');
  await f.pool.prepare(instance.instanceId);
  assert.equal(slot.textContent, '真实视图');
  assert.equal(calls, 2);
  f.pool.providerLoaded('business');
  assert.equal(calls, 2);
  await f.cleanup();
  assert.equal(releases, 1);
});

test('挂载池处理目标换代及旧代晚到释放，不覆盖新代DOM', async () => {
  const late = deferred<Dispose>(), entered = deferred<void>();
  let calls = 0, oldReleased = 0;
  const f = fixture(async (_id, target) => {
    calls++;
    target.textContent = calls === 1 ? 'old' : 'new';
    if (calls === 1) { entered.resolve(); return late.promise; }
    return () => { target.textContent = ''; };
  });
  const instance = f.ui.snapshot().instances[0];
  assert.ok(instance);
  const slot = f.document.createElement('div');
  f.pool.attach(instance.instanceId, slot);
  const old = f.pool.prepare(instance.instanceId);
  await entered.promise;
  f.ui.setTarget(instance.instanceId, 'new-target');
  f.pool.attach(instance.instanceId, slot);
  await f.pool.prepare(instance.instanceId);
  late.resolve(() => { oldReleased++; });
  await old;
  assert.equal(oldReleased, 1);
  assert.equal(slot.textContent, 'new');
  await f.cleanup();
});

test('取消候选准备不提交替换，也不清除原视图', async () => {
  const entered = deferred<void>();
  const f = fixture(async (_id, _target, signal) => new Promise<Dispose>((_resolve, reject) => {
    entered.resolve();
    signal.addEventListener('abort', () => reject(new Error('准备已取消')), { once: true });
  }));
  const original = f.ui.snapshot().instances[0];
  assert.ok(original);
  const layout = f.ui.readLayout(original.workspaceId);
  const cancellation = new AbortController();
  const pending = assert.rejects(f.controller.replace(original.instanceId,
    { pluginId: 'business', viewId: 'business.alternative' }, cancellation.signal), /取消|撤销/);
  await entered.promise;
  cancellation.abort();
  await pending;
  assert.deepEqual(f.ui.readLayout(original.workspaceId), layout);
  assert.equal(f.ui.snapshot().instances.length, 1);
  await f.cleanup();
});

test('某视图回收失败留下可查询记录，不阻止另一视图继续挂载', async () => {
  let fail = true;
  const f = fixture(async () => {
    const shouldFail = fail;
    fail = false;
    return async () => { if (shouldFail) throw new Error('旧回收失败'); };
  });
  const original = f.ui.snapshot().instances[0];
  assert.ok(original);
  await f.pool.prepare(original.instanceId);
  await f.pool.drop(original.instanceId);
  assert.equal(f.pool.cleanupSnapshot().length, 1);
  const next = await f.controller.add({ pluginId: 'business', viewId: 'business.alternative' }, 'floating');
  assert.equal(f.pool.status(next).state, 'ready');
  assert.equal(f.pool.cleanupSnapshot().length, 1);
  await f.cleanup();
});
