import assert from 'node:assert/strict';
import test from 'node:test';
import { createPluginManager } from '../src/plugins/manager.ts';
import type { HostContext, WebPlugin } from '../src/plugin-sdk/index.ts';
import { deferred } from './fixtures.ts';
import { dom } from './dom-fixtures.ts';
import { createNamedSlotAdapter } from '../src/plugins/extensions/slots.ts';
import { awaitLifecycle } from '../src/plugins/lifecycle.ts';

const forever = () => new Promise<never>(() => undefined);
function host(): HostContext {
  return {
    apiVersion: 2, signal: new AbortController().signal,
    listOperations: async () => ({ data: [], logId: null }),
    submit: forever, getJob: forever, cancelJob: forever,
    subscribeOperations: () => () => undefined, onDispose: () => () => undefined,
  };
}
function plugin(id: string, extra: Partial<WebPlugin> = {}): WebPlugin {
  return { id, version: '1', apiVersion: 2, panels: [], ...extra };
}

test('不返回的激活可取消，且无关插件不必等待', { timeout: 1500 }, async () => {
  const manager = createPluginManager({ host: host(), panelTarget: () => null });
  const entered = deferred<void>();
  manager.register({ id: 'stuck', trusted: true, plugin: plugin('stuck', {
    activate: async () => { entered.resolve(); await forever(); },
  }) });
  manager.register({ id: 'other', trusted: true, plugin: plugin('other') });
  const loading = assert.rejects(manager.load('stuck'));
  await entered.promise;
  try {
    assert.equal((await manager.load('other')).state, 'loaded');
    await manager.unload('stuck');
    await loading;
  } finally { void manager.dispose().catch(() => undefined); }
});

test('装载固定预算到期后撤销贡献且允许重新装载', { timeout: 1500 }, async () => {
  const manager = createPluginManager({ host: host(), panelTarget: () => null,
    timeouts: { loadMs: 25, mountMs: 25, cleanupMs: 25 } });
  manager.register({ id: 'stuck', trusted: true, loader: forever });
  await assert.rejects(manager.load('stuck'), /期限|超时/);
  assert.deepEqual(manager.snapshot(), []);
  await manager.dispose();
});

test('挂载不返回时卸载能收敛，迟到释放不碰新代', { timeout: 1500 }, async () => {
  const late = deferred<() => void>();
  const entered = deferred<void>();
  let releases = 0;
  const target = dom();
  const manager = createPluginManager({ host: host(), panelTarget: () => target,
    timeouts: { loadMs: 100, mountMs: 100, cleanupMs: 25 } });
  manager.register({ id: 'demo', trusted: true, plugin: plugin('demo', {
    panels: [{ id: 'demo.panel', title: '测试', mount: async () => { entered.resolve(); return late.promise; } }],
  }) });
  await manager.load('demo');
  const mounting = assert.rejects(manager.mount('demo', 'demo.panel'));
  await entered.promise;
  await manager.unload('demo');
  await mounting;
  await manager.load('demo');
  late.resolve(() => { releases++; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(releases, 1);
  assert.equal(manager.snapshot()[0]?.state, 'loaded');
  await manager.dispose();
});

test('槽位申请不返回时可撤销扩展，晚到租约只释放原申请', { timeout: 1500 }, async () => {
  const entered = deferred<void>();
  const late = deferred<{ target: HTMLElement; dispose: () => void }>();
  let releases = 0;
  const manager = createPluginManager({ host: host(), panelTarget: () => null,
    slotAdapter: { acquire: async () => { entered.resolve(); return late.promise; } },
    timeouts: { loadMs: 100, mountMs: 1000, cleanupMs: 25 } });
  manager.register({ id: 'demo', trusted: true, plugin: plugin('demo', { contributions: {
    components: [{ id: 'demo.widget', title: '测试', slot: 'route.devices', mode: 'replace', mount: async () => () => undefined }],
  } }) });
  try {
    await manager.load('demo');
    const pending = assert.rejects(manager.mountComponent('demo.widget'));
    await entered.promise;
    await manager.unmountExtension('demo.widget'); await pending;
    assert.equal(manager.snapshot()[0]?.state, 'loaded');
    late.resolve({ target: dom(), dispose: () => { releases++; } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(releases, 1);
  } finally { await manager.dispose(); }
});

test('默认槽位渲染超时不堵独立槽位，迟到释放不会覆盖新定义', { timeout: 1500 }, async () => {
  const late = deferred<() => void>(); let releases = 0;
  const slots = await createNamedSlotAdapter([], { mountMs: 25, cleanupMs: 25 });
  const failed = assert.rejects(slots.define({ id: 'slow', target: dom(), renderDefault: () => late.promise }), /期限|超时/);
  const releaseOther = await slots.define({ id: 'other', target: dom() });
  await failed;
  const target = dom();
  const releaseNew = await slots.define({ id: 'slow', target, renderDefault: (root) => {
    root.textContent = '新默认'; return () => { root.textContent = ''; };
  } });
  late.resolve(() => { releases++; }); await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(releases, 1); assert.equal(target.textContent, '新默认');
  await releaseNew(); await releaseOther(); await slots.dispose();
});

test('默认槽位清理不返回时释放有界，后续同名定义可继续', { timeout: 1500 }, async () => {
  const slots = await createNamedSlotAdapter([], { mountMs: 200, cleanupMs: 25 });
  const release = await slots.define({ id: 'slow', target: dom(), renderDefault: () => forever });
  await assert.rejects(Promise.resolve(release()), (error: unknown) => error instanceof AggregateError &&
    error.errors.some((failure: unknown) => failure instanceof Error && /期限|超时/.test(failure.message)));
  const next = await slots.define({ id: 'slow', target: dom() });
  await next(); await slots.dispose();
});

test('撤销发生在回调微任务执行前，不再进入用户回调', async () => {
  const controller = new AbortController(); let called = false;
  const pending = awaitLifecycle(() => { called = true; }, controller.signal, Date.now() + 100, '测试');
  controller.abort();
  await assert.rejects(pending, /撤销/);
  assert.equal(called, false);
});

test('同步回调阻塞超过绝对期限，返回后也不能宣布成功', async () => {
  let now = 1000; const original = Date.now;
  Date.now = () => now;
  try {
    await assert.rejects(awaitLifecycle(() => { now = 1011; return 'late'; }, undefined, 1010, '测试'), /期限/);
  } finally { Date.now = original; }
});

test('一次挂载失败共用清理期限且同一槽位只释放一次', { timeout: 1500 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let releases = 0;
  const releaseEntered = deferred<void>();
  const target = dom();
  const manager = createPluginManager({ host: host(), panelTarget: () => null,
    slotAdapter: { acquire: async () => ({ target, dispose: () => { releases++; releaseEntered.resolve(); return forever(); } }) },
    timeouts: { loadMs: 100, mountMs: 100, cleanupMs: 25 } });
  manager.register({ id: 'demo', trusted: true, plugin: plugin('demo', { contributions: {
    components: [{ id: 'demo.widget', title: '测试', slot: 'route.devices', mount: async () => { throw new Error('挂载失败'); } }],
  } }) });
  await manager.load('demo');
  const result = assert.rejects(manager.mountComponent('demo.widget'));
  await releaseEntered.promise;
  t.mock.timers.tick(25);
  await result;
  assert.equal(releases, 1);
  await manager.dispose();
});
