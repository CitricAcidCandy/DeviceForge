import assert from 'node:assert/strict';
import test from 'node:test';
import type { Dispose, HostContext } from '../src/plugin-sdk/index.ts';
import { createWorkspaceRendering } from '../src/plugins/workspace-rendering.ts';
import { createWorkspaceRegistry } from '../src/plugins/workspace/index.ts';
import { createPluginScope } from '../src/plugins/scope.ts';
import { deferred } from './fixtures.ts';
import { dom } from './dom-fixtures.ts';

const forever = () => new Promise<never>(() => undefined);
function fixture() {
  const registry = createWorkspaceRegistry();
  const owner = new AbortController();
  const model = registry.access({ pluginId: 'shell', generation: 1, signal: owner.signal });
  const rendering = createWorkspaceRendering({ mountMs: 50, cleanupMs: 30 });
  const ui = rendering.access(model);
  const host: HostContext = {
    apiVersion: 2, signal: owner.signal, ui,
    listOperations: async () => ({ data: [], logId: null }),
    submit: forever, getJob: forever, cancelJob: forever,
    subscribeOperations: () => () => {}, onDispose: (release) => release,
  };
  return { registry, owner, model, rendering, ui, host };
}

test('纯模型没有mount，公开access可在renderer后置注入前后保持稳定', async () => {
  const f = fixture();
  assert.equal(f.model.mount, undefined);
  const mount = f.ui.mount;
  assert.ok(mount);
  const target = dom();
  await assert.rejects(mount('view', target, f.owner.signal), /当前不可用/);
  let releases = 0;
  f.rendering.setRenderer(async (_id, root) => {
    root.textContent = 'mounted';
    return () => { releases++; root.textContent = ''; };
  });
  const release = await mount('view', target, f.owner.signal);
  assert.equal(target.textContent, 'mounted');
  await release(); await release();
  assert.equal(releases, 1);
  await f.rendering.dispose(); f.registry.dispose();
});

test('切换renderer撤销已挂载资源，旧renderer释放不能撤销新renderer', async () => {
  const f = fixture();
  const mount = f.ui.mount;
  assert.ok(mount);
  let oldReleases = 0, newReleases = 0;
  const oldRendererRelease = f.rendering.setRenderer(async () => () => { oldReleases++; });
  const oldViewRelease = await mount('view', dom(), f.owner.signal);
  f.rendering.setRenderer(async () => () => { newReleases++; });
  await oldRendererRelease();
  const release = await mount('view', dom(), f.owner.signal);
  await oldViewRelease();
  assert.equal(oldReleases, 1);
  assert.equal(newReleases, 0);
  await release();
  assert.equal(newReleases, 1);
  await f.rendering.dispose(); f.registry.dispose();
});

test('撤销renderer立即收敛等待，晚到release只释放旧请求且不自动重挂', async () => {
  const f = fixture();
  const mount = f.ui.mount;
  assert.ok(mount);
  const late = deferred<Dispose>();
  const entered = deferred<void>();
  let lateReleased = 0, calls = 0;
  f.rendering.setRenderer(async (_id, _target, signal) => {
    calls++; entered.resolve();
    assert.equal(signal.aborted, false);
    return late.promise;
  });
  const pending = assert.rejects(mount('view', dom(), f.owner.signal), /撤销/);
  await entered.promise;
  f.rendering.setRenderer(null);
  await pending;
  late.resolve(() => { lateReleased++; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(lateReleased, 1);
  assert.equal(calls, 1);
  await f.rendering.dispose(); f.registry.dispose();
});

test('子scope撤销先取消公开等待，晚到release归旧scope且不影响新scope', async () => {
  const f = fixture();
  const late = deferred<Dispose>();
  const entered = deferred<void>();
  let calls = 0, oldReleased = 0, newReleased = 0;
  f.rendering.setRenderer(async () => {
    calls++;
    if (calls === 1) { entered.resolve(); return late.promise; }
    return () => { newReleased++; };
  });
  const child = createPluginScope(f.host);
  const mount = child.context.ui?.mount;
  assert.ok(mount);
  const pending = assert.rejects(mount('view', dom(), child.context.signal), /撤销/);
  await entered.promise;
  await child.dispose();
  await pending;
  const next = createPluginScope(f.host);
  const nextMount = next.context.ui?.mount;
  assert.ok(nextMount);
  await nextMount('view', dom(), next.context.signal);
  late.resolve(() => { oldReleased++; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(oldReleased, 1);
  assert.equal(newReleased, 0);
  assert.throws(() => child.context.ui?.mount?.('view', dom(), child.context.signal), /作用域已撤销/);
  await next.dispose();
  assert.equal(newReleased, 1);
  await f.rendering.dispose(); f.registry.dispose();
});

test('renderer永不返回时有界失败，独立新挂载继续可用', { timeout: 2000 }, async () => {
  const f = fixture();
  const mount = f.ui.mount;
  assert.ok(mount);
  f.rendering.setRenderer(forever);
  await assert.rejects(mount('view', dom(), f.owner.signal), /期限/);
  let released = false;
  f.rendering.setRenderer(async () => () => { released = true; });
  await (await mount('view', dom(), f.owner.signal))();
  assert.equal(released, true);
  await f.rendering.dispose(); f.registry.dispose();
});

test('清理永不返回时有界保留错误，不阻止新renderer挂载', { timeout: 2000 }, async () => {
  const f = fixture();
  const mount = f.ui.mount;
  assert.ok(mount);
  f.rendering.setRenderer(async () => forever);
  const release = await mount('view', dom(), f.owner.signal);
  await assert.rejects(Promise.resolve(release()), /期限/);
  assert.equal(f.rendering.cleanupSnapshot().length, 1);
  f.rendering.setRenderer(async () => () => {});
  await (await mount('view', dom(), f.owner.signal))();
  assert.equal(f.rendering.cleanupSnapshot().length, 1);
  await f.rendering.dispose(); f.registry.dispose();
});

test('子scope面对忽略取消的上游也立即结束等待，迟到释放归旧scope', { timeout: 2000 }, async () => {
  const f = fixture();
  const late = deferred<Dispose>();
  const entered = deferred<void>();
  let released = 0;
  const child = createPluginScope({
    ...f.host,
    ui: {
      ...f.model,
      mount: async () => { entered.resolve(); return late.promise; },
    },
  });
  const mount = child.context.ui?.mount;
  assert.ok(mount);
  const pending = assert.rejects(mount('view', dom(), child.context.signal), /撤销/);
  await entered.promise;
  await child.dispose();
  await pending;
  late.resolve(() => { released++; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(released, 1);
  await f.rendering.dispose(); f.registry.dispose();
});

test('根dispose撤销已挂资源且对永不结束的release有界报告', { timeout: 2000 }, async () => {
  const f = fixture();
  const mount = f.ui.mount;
  assert.ok(mount);
  let signal: AbortSignal | undefined;
  f.rendering.setRenderer(async (_id, _target, running) => { signal = running; return forever; });
  await mount('view', dom(), f.owner.signal);
  const disposal = f.rendering.dispose();
  assert.equal(signal?.aborted, true);
  await assert.rejects(disposal, /回收不完整/);
  assert.equal(f.rendering.cleanupSnapshot().length, 1);
  assert.equal(f.rendering.dispose(), disposal);
  f.registry.dispose();
});
