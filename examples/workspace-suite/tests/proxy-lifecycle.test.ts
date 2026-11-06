import test from 'node:test';
import assert from 'node:assert/strict';
import { HostError } from '@deviceforge/plugin-sdk';
import type { Dispose, HostContext, UiAccess, WorkspaceViewContext } from '@deviceforge/plugin-sdk';
import { mountFileDelegate } from '../browser/proxy-view.ts';
import { hostFixture } from './host-fixture.ts';

function fixture() {
  const f = hostFixture(), lifetime = new AbortController(), visibility = new Set<(visible: boolean) => void>();
  f.setCatalog({ workspaces: [], pages: [], views: [{
    id: 'public_files.browser', pluginId: 'public_files', generation: 1, title: '文件',
    provides: ['files.browser'],
  }] });
  const original = f.ui.open({
    instanceId: `${f.prefix}.caller`, workspaceId: 'chosen.workspace',
    provider: { pluginId: f.prefix, viewId: `${f.prefix}.main` }, target: { chosen: 'explicit' },
  }, lifetime.signal);
  const view: WorkspaceViewContext = {
    signal: lifetime.signal, snapshot: () => original,
    subscribeVisibility(listener) { visibility.add(listener); return () => { visibility.delete(listener); }; },
  };
  return { ...f, lifetime, view, visibility, original };
}

/** 模拟公开 open 的信号归属及撤销后不可继续调用的工作区端口。 */
function scopedFixture() {
  const f = fixture(), ownedReleases: string[] = [];
  let closeAttempts = 0;
  const ui: UiAccess = {
    ...f.ui,
    open(input, signal) {
      const instance = f.ui.open(input, signal);
      signal?.addEventListener('abort', () => {
        f.instances.delete(input.instanceId);
        ownedReleases.push(input.instanceId);
      }, { once: true });
      return instance;
    },
    close(id) {
      closeAttempts++;
      if (f.context.signal.aborted)
        throw new HostError('cancelled', 'workspace_scope_revoked', '此工作区端口所属上下文已撤销');
      f.ui.close(id);
    },
  };
  const context: HostContext = { ...f.context, ui };
  return { ...f, context, ownedReleases, get closeAttempts() { return closeAttempts; } };
}

test('公开文件视图委托拥有独立实例，隐藏同步，关闭只回收自己的委托且幂等', async () => {
  const f = fixture();
  let released = 0, delegateId = '';
  const dispose = await mountFileDelegate(f.context, f.view, f.prefix, async (id, signal) => {
    delegateId = id;
    assert.equal(signal.aborted, false);
    return () => { released++; };
  });
  assert.notEqual(delegateId, f.original.instanceId);
  assert.deepEqual(f.instances.get(delegateId)?.target, f.original.target);
  for (const update of [...f.visibility]) update(false);
  assert.equal(f.instances.get(delegateId)?.visible, false);
  await dispose(); await dispose();
  assert.equal(released, 1);
  assert.deepEqual(f.closed, [delegateId]);
  assert.ok(f.instances.has(f.original.instanceId));
  assert.equal(f.visibility.size, 0);
  assert.equal(f.layouts.size, 0);
});

test('挂载晚到期间撤销先关闭自有委托，晚返回只释放旧挂载，不创建新实例或修改布局', async () => {
  const f = fixture();
  let complete: (release: Dispose) => void = () => {}, released = 0;
  const late = new Promise<Dispose>((resolve) => { complete = resolve; });
  const pending = mountFileDelegate(f.context, f.view, f.prefix, async () => late);
  const rejected = assert.rejects(pending, (error) => error instanceof DOMException && error.name === 'AbortError');
  f.lifetime.abort();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.closed.length, 1);
  complete(() => { released++; });
  await rejected;
  assert.equal(released, 1);
  assert.equal(f.opened.length, 2);
  assert.ok(f.instances.has(f.original.instanceId));
  assert.equal(f.visibility.size, 0);
  assert.equal(f.layouts.size, 0);
});

test('上下文撤销后委托已归属 open 信号，释放仍收回可见性和渲染但不调用撤销的 close', async () => {
  const f = scopedFixture();
  let released = 0, delegateId = '';
  const dispose = await mountFileDelegate(f.context, f.view, f.prefix, async (id) => {
    delegateId = id;
    return () => { released++; };
  });
  f.signal.abort();
  await dispose();
  await dispose();
  assert.deepEqual(f.ownedReleases, [delegateId]);
  assert.equal(f.instances.has(delegateId), false);
  assert.equal(f.closeAttempts, 0);
  assert.equal(f.visibility.size, 0);
  assert.equal(released, 1);
  assert.ok(f.instances.has(f.original.instanceId));
});

test('上下文撤销时迟到渲染仍只释放一次，不用已撤销端口关闭或掩盖原取消', async () => {
  const f = scopedFixture();
  let complete: (release: Dispose) => void = () => {}, released = 0, delegateId = '';
  const late = new Promise<Dispose>((resolve) => { complete = resolve; });
  const pending = mountFileDelegate(f.context, f.view, f.prefix, async (id) => {
    delegateId = id;
    return late;
  });
  const rejected = assert.rejects(pending, (error) => error instanceof DOMException && error.name === 'AbortError');
  f.signal.abort();
  complete(() => { released++; });
  await rejected;
  assert.equal(released, 1);
  assert.equal(f.closeAttempts, 0);
  assert.deepEqual(f.ownedReleases, [delegateId]);
  assert.equal(f.visibility.size, 0);
  assert.equal(f.opened.length, 2);
  assert.ok(f.instances.has(f.original.instanceId));
});

test('上下文撤销跳过 close 仍保留真实渲染释放异常，不能把故障吞成成功', async () => {
  const f = scopedFixture(), failure = new Error('真实渲染资源释放失败');
  let released = 0;
  const dispose = await mountFileDelegate(f.context, f.view, f.prefix, async () => () => {
    released++;
    throw failure;
  });
  f.signal.abort();
  await assert.rejects(Promise.resolve(dispose()), (error) => error instanceof AggregateError &&
    error.errors.length === 1 && error.errors[0] === failure);
  assert.equal(f.closeAttempts, 0);
  assert.equal(f.visibility.size, 0);
  assert.equal(released, 1);
});

test('委托订阅间隙隐藏按登记后快照校准，恢复只同步原委托且旧通知不能复活', async () => {
  const f = fixture(), retained: ((visible: boolean) => void)[] = [];
  let current = f.original, rendering = 0, released = 0, visibleWrites = 0, visibleAtRender: boolean | undefined;
  const ui: UiAccess = { ...f.ui, setVisible(id, visible) {
    visibleWrites++; return f.ui.setVisible(id, visible);
  } };
  const context: HostContext = { ...f.context, ui };
  const instance: WorkspaceViewContext = {
    signal: f.lifetime.signal, snapshot: () => current,
    subscribeVisibility(listener) {
      // 父视图在首快照与订阅登记之间隐藏，故意不回放已经发生的通知。
      current = f.ui.setVisible(f.original.instanceId, false);
      retained.push(listener); f.visibility.add(listener);
      return () => { f.visibility.delete(listener); };
    },
  };
  let dispose: Dispose | null = null, delegateId = '';
  try {
    dispose = await mountFileDelegate(context, instance, f.prefix, async (id) => {
      delegateId = id; rendering++;
      visibleAtRender = f.instances.get(id)?.visible;
      return () => { released++; };
    });
    assert.equal(visibleAtRender, false, '渲染开始前必须采用登记后的隐藏快照');
    assert.equal(f.instances.get(delegateId)?.visible, false);
    const parentAfterHide = structuredClone(f.instances.get(f.original.instanceId));
    const originalTarget = structuredClone(f.original.target);
    for (const listener of [...f.visibility]) listener(true);
    assert.equal(f.instances.get(delegateId)?.visible, true);
    for (const listener of [...f.visibility]) listener(false);
    assert.equal(f.instances.get(delegateId)?.visible, false);
    assert.equal(rendering, 1, '显隐同步不能重新挂载委托');
    assert.equal(f.opened.length, 2);
    assert.deepEqual(f.instances.get(delegateId)?.target, originalTarget);
    assert.deepEqual(f.instances.get(f.original.instanceId), parentAfterHide, '同步不能改父实例');
    assert.equal(f.layouts.size, 0);
    await dispose();
    assert.equal(released, 1);
    assert.equal(f.visibility.size, 0);
    assert.deepEqual(f.closed, [delegateId]);
    const afterClose = visibleWrites;
    for (const listener of retained) listener(true);
    assert.equal(visibleWrites, afterClose, '撤销后的旧通知不能调用已关闭委托');
    assert.equal(f.instances.has(delegateId), false);
    assert.deepEqual(f.instances.get(f.original.instanceId), parentAfterHide);
    assert.equal(f.counts.businessCalls, 0);
  } finally {
    await dispose?.(); f.lifetime.abort(); await f.dispose();
  }
});

test('委托订阅后快照失败返回原异常并仅回滚自有实例，同根独立新挂载可继续', async () => {
  const f = fixture(), failure = new Error('订阅后的父可见性快照不可读');
  const other = f.ui.open({
    instanceId: `${f.prefix}.unrelated`, workspaceId: 'other.workspace',
    provider: { pluginId: f.prefix, viewId: `${f.prefix}.other` }, target: { other: 'keep' },
  }, f.lifetime.signal);
  const parent = structuredClone(f.instances.get(f.original.instanceId));
  let subscribed = false, failedReads = 0, renders = 0, fresh: Dispose | null = null;
  const leaked: Dispose[] = [];
  const retained: ((visible: boolean) => void)[] = [];
  const broken: WorkspaceViewContext = {
    signal: f.lifetime.signal,
    snapshot() {
      if (subscribed) { failedReads++; throw failure; }
      return f.original;
    },
    subscribeVisibility(listener) {
      subscribed = true; retained.push(listener); f.visibility.add(listener);
      return () => { f.visibility.delete(listener); };
    },
  };
  try {
    const pending = mountFileDelegate(f.context, broken, f.prefix, async () => {
      renders++; return () => {};
    }).then((dispose) => { leaked.push(dispose); return dispose; });
    await assert.rejects(pending, (error: unknown) => error === failure,
      '登记后校准失败必须抛原错误，不能开始渲染或冒充挂载成功');
    assert.equal(failedReads, 1);
    assert.equal(renders, 0);
    assert.equal(f.visibility.size, 0);
    const failedDelegate = f.opened.at(-1)?.instanceId; assert.ok(failedDelegate);
    assert.deepEqual(f.closed, [failedDelegate]);
    assert.equal(f.instances.has(failedDelegate), false);
    for (const listener of retained) listener(false);
    assert.deepEqual(f.instances.get(f.original.instanceId), parent);
    assert.deepEqual(f.instances.get(other.instanceId), other);
    let freshId = '', freshReleased = 0;
    fresh = await mountFileDelegate(f.context, f.view, f.prefix, async (id) => {
      freshId = id; renders++; return () => { freshReleased++; };
    });
    assert.notEqual(freshId, failedDelegate);
    assert.equal(renders, 1);
    assert.ok(f.instances.has(freshId));
    assert.deepEqual(f.instances.get(f.original.instanceId), parent);
    assert.deepEqual(f.instances.get(other.instanceId), other);
    assert.equal(f.layouts.size, 0);
    await fresh();
    assert.equal(freshReleased, 1);
    assert.equal(f.visibility.size, 0);
    assert.equal(f.counts.businessCalls, 0);
  } finally {
    for (const dispose of leaked) await dispose();
    await fresh?.(); f.lifetime.abort(); await f.dispose();
  }
});
