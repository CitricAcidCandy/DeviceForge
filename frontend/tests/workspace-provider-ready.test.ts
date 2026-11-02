import test from 'node:test';
import assert from 'node:assert/strict';
import type { Dispose, HostContext, WebPlugin } from '../src/plugin-sdk/index.ts';
import { createPluginManager } from '../src/plugins/manager.ts';
import { createExtensionRegistry } from '../src/plugins/extensions/registry.ts';
import { dom } from './dom-fixtures.ts';
import { deferred } from './fixtures.ts';

async function bounded<T>(value: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([value, new Promise<never>((_accept, reject) => {
      timeout = setTimeout(() => reject(new Error(`${label}没有在本地期限内收敛`)), 500);
    })]);
  } finally { clearTimeout(timeout); }
}

async function microtasks() {
  for (let turn = 0; turn < 12; turn++) await Promise.resolve();
}

function observe<T>(value: Promise<T>) {
  let state: 'pending' | 'fulfilled' | 'rejected' = 'pending';
  let error: unknown;
  void value.then(() => { state = 'fulfilled'; }, (failure: unknown) => {
    state = 'rejected'; error = failure;
  });
  return { value, state: () => state, error: () => error };
}

function fixture() {
  const lifetime = new AbortController();
  const unavailable = () => Promise.reject(new Error('挂载就绪单元不执行业务操作'));
  const host: HostContext = {
    apiVersion: 2, signal: lifetime.signal,
    listOperations: async () => ({ data: [], logId: null }),
    submit: unavailable, getJob: unavailable, cancelJob: unavailable,
    subscribeOperations: () => () => {}, onDispose: (dispose) => dispose,
  };
  const registry = createExtensionRegistry();
  const manager = createPluginManager({
    host, extensionRegistry: registry, panelTarget: () => null,
    timeouts: { loadMs: 1000, mountMs: 250, cleanupMs: 100 },
  });
  const ui = registry.uiAccess(host);
  const render = ui.mount ?? assert.fail('根公开 uiAccess 必须提供真实工作区挂载');
  const target = dom();
  const fallback = target.ownerDocument.createElement('p');
  fallback.textContent = '原业务草稿';
  target.append(fallback);
  const plans: { ready: ReturnType<typeof deferred<void>>; entered: ReturnType<typeof deferred<void>>; fail: boolean }[] = [];
  const loading: Promise<unknown>[] = [];
  let activations = 0, mounts = 0;
  const plugin: WebPlugin = {
    id: 'provider', version: '1', apiVersion: 2, panels: [],
    async activate(context) {
      const plan = plans[activations++];
      assert.ok(plan, '每代激活必须由测试显式设置可控门');
      const activation = activations;
      assert.ok(context.ui);
      context.ui.register({ views: [{
        id: 'provider.view', title: '提供者完整视图',
        async mount(root) {
          mounts++;
          root.textContent = `就绪视图${activation}`;
          return () => {};
        },
      }] });
      plan.entered.resolve();
      await plan.ready.promise;
      context.signal.throwIfAborted();
      if (plan.fail) throw new Error('提供者激活失败');
    },
  };
  manager.register({ id: plugin.id, trusted: true, plugin });
  function begin(fail = false) {
    const plan = { ready: deferred<void>(), entered: deferred<void>(), fail };
    plans.push(plan);
    const current = observe(manager.load(plugin.id));
    loading.push(current.value);
    return { ...plan, loading: current.value };
  }
  function open(instanceId = 'host.consumer.one') {
    return ui.open({
      instanceId, workspaceId: 'host.consumer.workspace',
      provider: { pluginId: plugin.id, viewId: 'provider.view' },
      target: { draft: '公开消费者目标' },
    }, lifetime.signal);
  }
  function pending(instanceId = 'host.consumer.one', signal?: AbortSignal) {
    return observe(render(instanceId, target, signal ?? lifetime.signal));
  }
  async function dispose() {
    lifetime.abort();
    for (const plan of plans) plan.ready.resolve();
    try {
      await bounded(manager.unload(plugin.id), '撤销提供者');
      await bounded(Promise.allSettled(loading), '收敛提供者装载');
    } finally {
      try { await bounded(manager.dispose(), '销毁真实管理器'); }
      finally { registry.dispose(); target.ownerDocument.defaultView?.close(); }
    }
  }
  return { manager, registry, ui, target, fallback, begin, open, pending, dispose, mounts: () => mounts };
}

function assertWaiting(current: ReturnType<ReturnType<typeof fixture>['pending']>) {
  const error = current.error();
  assert.equal(current.state(), 'pending',
    `提供者激活未完成时应继续等待同一次公开挂载，不能提前拒绝：${error instanceof Error ? error.message : String(error)}`);
}

test('真实提供者激活先登记视图时公开挂载等待就绪，同一次请求只挂载一次',
  { timeout: 2500 }, async () => {
    const f = fixture();
    let release: Dispose = () => {};
    try {
      const activation = f.begin();
      await bounded(activation.entered.promise, '提供者登记视图');
      assert.equal(f.ui.catalog().views.some((view) => view.id === 'provider.view'), true);
      f.open();
      const current = f.pending();
      await microtasks();
      assertWaiting(current);
      assert.equal(f.mounts(), 0, '未就绪不得执行视图挂载回调');
      assert.equal(f.target.textContent, '原业务草稿');
      activation.ready.resolve();
      await bounded(activation.loading, '完成提供者激活');
      release = await bounded(current.value, '继续同一次公开挂载');
      assert.equal(f.mounts(), 1);
      assert.equal(f.target.textContent, '原业务草稿就绪视图1');
      assert.equal(f.fallback.parentElement, f.target);
      await release();
      assert.equal(f.target.textContent, '原业务草稿');
    } finally { await release(); await f.dispose(); }
  });

test('公开挂载等待可被caller立即取消，晚到loaded不写旧DOM且独立新挂载成功',
  { timeout: 2500 }, async () => {
    const f = fixture(), caller = new AbortController();
    let release: Dispose = () => {};
    try {
      const activation = f.begin();
      await bounded(activation.entered.promise, '提供者登记视图');
      f.open();
      const old = f.pending('host.consumer.one', caller.signal);
      await microtasks();
      assertWaiting(old);
      caller.abort();
      await bounded(assert.rejects(old.value, /撤销|取消/), '取消公开挂载等待');
      assert.equal(f.target.textContent, '原业务草稿');
      activation.ready.resolve();
      await bounded(activation.loading, '提供者晚到激活完成');
      await microtasks();
      assert.equal(f.mounts(), 0, '提供者loaded不得替已取消请求自动重放挂载');
      assert.equal(f.target.textContent, '原业务草稿');
      release = await bounded(f.pending().value, '独立的新挂载');
      assert.equal(f.mounts(), 1);
      assert.equal(f.target.textContent, '原业务草稿就绪视图1');
    } finally { caller.abort(); await release(); await f.dispose(); }
  });

test('激活失败、卸载或实例换代均收敛就绪等待，保留fallback且新代独立挂载',
  { timeout: 5000 }, async () => {
    for (const mode of ['failure', 'unload', 'instance']) {
      const f = fixture();
      let release: Dispose = () => {};
      try {
        const activation = f.begin(mode === 'failure');
        await bounded(activation.entered.promise, '提供者登记视图');
        const opened = f.open();
        const old = f.pending();
        await microtasks();
        assertWaiting(old);
        if (mode === 'failure') {
          activation.ready.resolve();
          await bounded(assert.rejects(activation.loading, /提供者激活失败/), '激活失败');
        } else if (mode === 'unload') {
          await bounded(f.manager.unload('provider'), '激活中撤销提供者');
          activation.ready.resolve();
          await bounded(assert.rejects(activation.loading, /撤销|取消/), '收敛已卸载装载');
        } else {
          f.ui.setTarget('host.consumer.one', { draft: '新代目标' });
          assert.notEqual(f.ui.snapshot().instances.find((entry) =>
            entry.instanceId === opened.instanceId)?.generation, opened.generation);
        }
        await bounded(assert.rejects(old.value, /激活失败|撤销|取消/), `${mode}结束旧等待`);
        assert.equal(f.mounts(), 0, '失效的等待不得执行视图挂载');
        assert.equal(f.target.textContent, '原业务草稿');
        assert.equal(f.fallback.parentElement, f.target);
        if (mode === 'instance') {
          activation.ready.resolve();
          await bounded(activation.loading, '当前提供者完成激活');
        } else {
          const next = f.begin();
          await bounded(next.entered.promise, '新代提供者登记视图');
          next.ready.resolve();
          await bounded(next.loading, '新代提供者完成激活');
        }
        f.open('host.consumer.next');
        release = await bounded(f.pending('host.consumer.next').value, '新代独立挂载');
        assert.equal(f.mounts(), 1);
        assert.equal(f.target.textContent, `原业务草稿就绪视图${mode === 'instance' ? '1' : '2'}`);
      } finally { await release(); await f.dispose(); }
    }
  });

test('就绪等待耗尽挂载预算后不自动重放，同caller可独立挂载新实例',
  { timeout: 2500 }, async (t) => {
    const f = fixture(), caller = new AbortController();
    let release: Dispose = () => {};
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    try {
      const activation = f.begin();
      await activation.entered.promise;
      f.open();
      const expired = f.pending('host.consumer.one', caller.signal);
      await microtasks();
      assertWaiting(expired);
      t.mock.timers.tick(249);
      await microtasks();
      assertWaiting(expired);
      t.mock.timers.tick(1);
      await microtasks();
      assert.equal(expired.state(), 'rejected', '等待就绪必须消耗原250毫秒挂载预算');
      await assert.rejects(expired.value, /期限|超时/);
      assert.equal(caller.signal.aborted, false, '单次挂载到期不能撤销caller后续独立调用');
      assert.equal(f.target.textContent, '原业务草稿');
      assert.equal(f.mounts(), 0);

      f.open('host.consumer.fresh');
      const fresh = f.pending('host.consumer.fresh', caller.signal);
      await microtasks();
      assertWaiting(fresh);
      activation.ready.resolve();
      await activation.loading;
      release = await fresh.value;
      assert.equal(f.mounts(), 1, '只有预算仍有效的新请求可以执行挂载');
      assert.equal(f.target.textContent, '原业务草稿就绪视图1');
    } finally {
      t.mock.timers.reset();
      caller.abort();
      await release();
      await f.dispose();
    }
  });
