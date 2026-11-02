import test from 'node:test';
import assert from 'node:assert/strict';
import type { Dispose, UiAccess } from '../src/plugin-sdk/index.ts';
import { HostError } from '../src/plugin-sdk/models.ts';
import { createWorkspaceRegistry } from '../src/plugins/workspace/index.ts';
import { createMountPool } from '../plugins/default-shell/src/mount-pool.ts';
import { dom } from './dom-fixtures.ts';
import { deferred } from './fixtures.ts';

const instanceId = 'deviceforge_shell.first';
const nextInstanceId = 'deviceforge_shell.second';

async function bounded<T>(value: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([value, new Promise<never>((_accept, reject) => {
      timeout = setTimeout(() => reject(new Error(`${label}没有在单元期限内收敛`)), 500);
    })]);
  } finally { clearTimeout(timeout); }
}

async function microtasks() {
  for (let turn = 0; turn < 16; turn++) await Promise.resolve();
}

function observed<T>(value: Promise<T>) {
  void value.catch(() => undefined);
  return value;
}

function fixture(mount: NonNullable<UiAccess['mount']>) {
  const registry = createWorkspaceRegistry();
  const provider = new AbortController(), owner = new AbortController();
  const providerUi = registry.access({ pluginId: 'provider', generation: 1, signal: provider.signal });
  providerUi.register({ views: [{
    id: 'provider.view', title: '正常提供者视图', mount: async () => () => {},
  }] });
  const access = registry.access({ pluginId: 'deviceforge_shell', generation: 1, signal: owner.signal });
  const ui: UiAccess = { ...access, mount };
  const target = dom(), document = target.ownerDocument;
  const staging = document.createElement('div');
  const pool = createMountPool(ui, document, owner.signal, staging);
  function open(id = instanceId) {
    ui.open({ instanceId: id, workspaceId: 'deviceforge_shell.work',
      provider: { pluginId: 'provider', viewId: 'provider.view' } }, owner.signal);
  }
  async function dispose() {
    owner.abort();
    try { await bounded(pool.dispose(), '回收挂载池'); }
    finally { provider.abort(); registry.dispose(); document.defaultView?.close(); }
  }
  open();
  return { ui, target, staging, pool, open, dispose };
}

test('延迟loaded通知不取消正常在途挂载，不重复执行并保留输入草稿和原DOM',
  { timeout: 2500 }, async () => {
    const ready = deferred<void>(), entered = deferred<void>();
    const inputs: HTMLInputElement[] = [], signals: AbortSignal[] = [];
    let calls = 0, releases = 0;
    const f = fixture(async (_id, root, signal) => {
      calls++;
      signals.push(signal);
      const input = root.ownerDocument.createElement('input');
      input.setAttribute('aria-label', '挂载中的插件草稿');
      root.append(input);
      inputs.push(input);
      entered.resolve();
      await ready.promise;
      signal.throwIfAborted();
      return () => { releases++; input.remove(); };
    });
    let detach: Dispose = () => {};
    const preparing = observed(f.pool.prepare(instanceId));
    try {
      detach = f.pool.attach(instanceId, f.target);
      await bounded(entered.promise, '进入正常挂载');
      const input = inputs[0], signal = signals[0], root = input?.parentElement;
      assert.ok(input && signal && root);
      input.value = '尚未保存的原始草稿';
      f.pool.providerLoaded('provider');
      await microtasks();
      assert.equal(signal.aborted, false, '同提供者的迟到loaded不能撤销正常在途挂载');
      assert.equal(calls, 1, '正常异步挂载不能因loaded通知重新执行');
      assert.equal(f.target.querySelector('input'), input);
      assert.equal(input.value, '尚未保存的原始草稿');
      ready.resolve();
      await bounded(preparing, '完成原来的同一次挂载');
      assert.equal(f.pool.status(instanceId).state, 'ready');
      assert.equal(f.target.querySelector('[data-shell-view]'), root);
      assert.equal(f.target.querySelector('input'), input);
      assert.equal(input.value, '尚未保存的原始草稿');
      assert.equal(calls, 1);
      await f.pool.dispose();
      assert.equal(releases, 1, '原挂载只回收一次');
      assert.equal(f.target.children.length, 0);
    } finally {
      ready.resolve();
      await Promise.allSettled([preparing]);
      await detach();
      await f.dispose();
    }
  });

test('loaded只兼容明确旧宿主早期拒绝，普通失败不自动重放且恢复保留显示归属',
  { timeout: 8000 }, async (t) => {
    for (const kind of ['provider-revoked', 'business', 'unknown']) {
      for (const timing of ['before-catch', 'after-catch']) {
        await t.test(`${kind} / ${timing}`, async () => {
          const failed = deferred<never>(), entered = deferred<void>(), recovered = deferred<void>();
          let calls = 0, releases = 0;
          const f = fixture(async (_id, root) => {
            const call = ++calls;
            const input = root.ownerDocument.createElement('input');
            input.value = `挂载${call}的草稿`;
            root.append(input);
            if (call === 1) { entered.resolve(); return failed.promise; }
            recovered.resolve();
            return () => { releases++; input.remove(); };
          });
          const first = observed(f.pool.prepare(instanceId));
          let oldDetach: Dispose = () => {}, newDetach: Dispose = () => {};
          try {
            oldDetach = f.pool.attach(instanceId, f.target);
            await bounded(entered.promise, '进入第一次挂载');
            if (timing === 'before-catch') f.pool.providerLoaded('provider');
            const error = kind === 'provider-revoked'
              ? new HostError('cancelled', 'workspace_provider_revoked', '旧宿主提供者尚未完成加载')
              : kind === 'business' ? new Error('业务挂载失败，不能推断允许重放') : '未知挂载失败';
            failed.reject(error);
            await bounded(assert.rejects(first), '收敛第一次失败');
            if (timing === 'after-catch') f.pool.providerLoaded('provider');
            await microtasks();
            if (kind === 'provider-revoked') {
              await bounded(recovered.promise, '明确旧宿主拒绝后的兼容补挂');
              await microtasks();
              assert.equal(calls, 2, '明确早期拒绝只允许一次兼容补挂');
              assert.equal(f.pool.status(instanceId).state, 'ready');
              assert.equal(f.target.querySelector('input')?.value, '挂载2的草稿');
              f.pool.providerLoaded('provider');
              await microtasks();
              assert.equal(calls, 2, 'ready状态不能被再次loaded重挂');

              f.open(nextInstanceId);
              const next = observed(f.pool.prepare(nextInstanceId));
              newDetach = f.pool.attach(nextInstanceId, f.target);
              await bounded(next, '同位置切换新实例');
              assert.deepEqual([...f.target.querySelectorAll('[data-shell-view]')].map((root) =>
                root.getAttribute('data-shell-view')), [nextInstanceId],
              '兼容恢复必须继承原显示位置，换实例后不能留下旧根');
              const nextInput = f.target.querySelector('input');
              await oldDetach();
              assert.equal(f.target.querySelector('input'), nextInput, '旧detach不能拆掉新实例');
              assert.equal(f.target.querySelector('input')?.value, '挂载3的草稿');
            } else {
              assert.equal(calls, 1, '普通业务错误或未知失败不得因loaded自动重放');
              assert.equal(f.pool.status(instanceId).state, 'failed');
              f.pool.providerLoaded('provider');
              await microtasks();
              assert.equal(calls, 1, '重复loaded同样不能重放未知业务');
              await bounded(f.pool.retry(instanceId), '用户显式重试');
              assert.equal(calls, 2);
              assert.equal(f.pool.status(instanceId).state, 'ready');
              const retriedInput = f.target.querySelector('input');
              await oldDetach();
              assert.equal(f.target.querySelector('input'), retriedInput, '失败前的旧释放不能拆新版');
            }
            await f.pool.dispose();
            assert.equal(releases, kind === 'provider-revoked' ? 2 : 1);
          } finally {
            failed.reject(new Error('测试回收未完成挂载'));
            await Promise.allSettled([first]);
            await oldDetach();
            await newDetach();
            await f.dispose();
          }
        });
      }
    }
  });
