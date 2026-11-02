import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendRuntime } from '../src/app/runtime.ts';
import { createShellHost, SHELL_POINT } from '../src/app/composition/shell-host.ts';
import type { JobFailureState, WebPlugin, WorkspaceMount } from '../src/plugin-sdk/index.ts';
import { JobFailure, JobWaitFailure } from '../src/plugin-sdk/index.ts';
import { HostError } from '../src/plugin-sdk/models.ts';
import { recoveryFailure } from '../src/app/composition/recovery-state.ts';
import { dom } from './dom-fixtures.ts';
import { deferred } from './fixtures.ts';

function fixture() {
  const runtime = createFrontendRuntime({
    baseUrl: 'http://127.0.0.1:7031', panelTarget: () => null, workspaceStorage: null,
    transport: async () => { throw new Error('外壳登记不应发送业务请求'); },
  });
  const target = dom();
  const shell = createShellHost({
    context: runtime.host, target,
    providerReady: (id, generation) => runtime.webPlugins.diagnosticSnapshot()
      .some((item) => item.id === id && item.generation === generation && item.state === 'loaded'),
  });
  async function add(id: string, mount: WorkspaceMount) {
    const plugin: WebPlugin = {
      id, version: '1.0.0', apiVersion: 2, panels: [],
      async activate(context) {
        context.ui?.register({ views: [{ id: `${id}.root`, title: id, provides: ['host.shell'], mount }] });
        context.extensions?.points?.contribute({
          id: `${id}.shell`, point: SHELL_POINT, mode: 'replace',
          data: { pluginId: id, viewId: `${id}.root` },
        });
      },
    };
    runtime.bundledPlugins.register({ id, trusted: true, loader: async () => plugin });
    await runtime.webPlugins.load(id);
  }
  return { runtime, target, shell, add, async dispose() { await shell.dispose(); await runtime.dispose(); } };
}
async function settled(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail('外壳没有在定向单元期限内收敛');
}

test('恢复错误读取跨SDK完整字段，不猜残缺对象或不可读取日志', () => {
  assert.deepEqual(recoveryFailure({ kind: 'http', code: 'remote_failure', message: '独立 SDK 本次失败',
    status: 500, logId: 'cross-sdk-log', retryAfter: null }, '未知错误'),
  { message: '独立 SDK 本次失败', logId: 'cross-sdk-log' });
  assert.deepEqual(recoveryFailure({ logId: 'unrelated-log' }, '未知错误'), { message: '未知错误', logId: null });
  const unreadable = { kind: 'http', code: 'unreadable', message: '不可读取的错误', status: 500, retryAfter: null,
    get logId(): string { throw new Error('不允许读取'); } };
  assert.deepEqual(recoveryFailure(unreadable, '未知错误'), { message: '未知错误', logId: null });
});

test('恢复任务错误读取公开SDK本机错误的本次日志ID', () => {
  const job: JobFailureState = { id: 'task-not-a-log', operation: 'example.run', status: 'failed', error: '本次任务失败' };
  assert.deepEqual(recoveryFailure(new JobFailure(job, 'submit-log', 'task-failure-log'), '未知错误'),
    { message: '本次任务失败', logId: 'task-failure-log' });
  const cause = new HostError('http', 'wait_failed', '本次等待失败', 'cause-log', 500);
  assert.deepEqual(recoveryFailure(new JobWaitFailure(job, 'submit-log', 'wait-failure-log', cause, 'previous-log'), '未知错误'),
    { message: '本次等待失败', logId: 'wait-failure-log' });
});

test('恢复任务错误无本次日志ID时不借其他标识，普通Error不因同名获得日志身份', () => {
  const job: JobFailureState = { id: 'task-not-a-log', operation: 'example.run', status: 'failed', error: '任务未提供日志' };
  assert.deepEqual(recoveryFailure(new JobFailure(job, 'submit-log', null), '未知错误'),
    { message: '任务未提供日志', logId: null });
  const cause = new HostError('http', 'wait_failed', '等待未提供日志', 'cause-log', 500);
  assert.deepEqual(recoveryFailure(new JobWaitFailure(job, 'submit-log', null, cause, 'previous-log'), '未知错误'),
    { message: '等待未提供日志', logId: null });
  const incomplete = Object.assign(new Error('普通错误并非公开任务错误'), {
    name: 'JobFailure', job, logId: 'guessed-log', submitLogId: 'submit-log', lastKnownLogId: 'previous-log', cause,
  });
  assert.deepEqual(recoveryFailure(incomplete, '未知错误'), { message: '普通错误并非公开任务错误', logId: null });
});

test('外壳贡献不会按加载顺序抢占，显式选择后才显示', async () => {
  const current = fixture();
  try {
    await current.add('shell_a', async (target) => { target.textContent = '甲外壳'; return () => {}; });
    assert.equal(current.shell.snapshot().state, 'empty');
    assert.equal(current.target.textContent, '');
    current.runtime.host.extensions?.points?.select(SHELL_POINT, 'shell_a.shell');
    await settled(() => current.shell.snapshot().state === 'ready');
    assert.equal(current.target.textContent, '甲外壳');
    assert.equal(current.shell.snapshot().active?.pluginId, 'shell_a');
  } finally { await current.dispose(); }
});

test('新外壳准备失败保留原外壳，并保留可查错误', async () => {
  const current = fixture();
  try {
    await current.add('shell_a', async (target) => { target.textContent = '甲外壳草稿'; return () => {}; });
    current.runtime.host.extensions?.points?.select(SHELL_POINT, 'shell_a.shell');
    await settled(() => current.shell.snapshot().state === 'ready');
    await current.add('shell_b', async () => { throw new Error('乙外壳无法渲染'); });
    current.runtime.host.extensions?.points?.select(SHELL_POINT, 'shell_b.shell');
    await settled(() => current.shell.snapshot().state === 'failed');
    assert.equal(current.target.textContent, '甲外壳草稿');
    assert.equal(current.shell.snapshot().active?.pluginId, 'shell_a');
    assert.match(current.shell.snapshot().error ?? '', /乙外壳无法渲染/);
  } finally { await current.dispose(); }
});

test('外壳失败不因其他插件或重复就绪通知重放，显式重试仍能继续', async () => {
  const current = fixture();
  let attempts = 0;
  try {
    await current.add('shell_a', async (target) => {
      const input = target.ownerDocument.createElement('input');
      input.value = '原外壳草稿';
      target.append(input);
      return () => {};
    });
    current.runtime.host.extensions?.points?.select(SHELL_POINT, 'shell_a.shell');
    await settled(() => current.shell.snapshot().state === 'ready');
    const original = current.target.querySelector('input');
    await current.add('shell_b', async (target) => {
      attempts++;
      if (attempts === 1) throw new HostError('http', 'render_failed', '本次外壳失败', 'shell-first-log', 500);
      target.textContent = '显式重新打开成功';
      return () => {};
    });
    current.runtime.host.extensions?.points?.select(SHELL_POINT, 'shell_b.shell');
    await settled(() => current.shell.snapshot().state === 'failed');
    await current.add('unrelated_plugin', async () => () => {});
    const provider = current.runtime.webPlugins.diagnosticSnapshot().find((entry) => entry.id === 'shell_b');
    assert.ok(provider);
    current.runtime.host.extensions?.emitEvent('host.plugins.changed', {
      pluginId: provider.id, generation: provider.generation, stage: 'loaded',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(attempts, 1, '生命周期通知不能重放已经失败的同一次外壳挂载');
    assert.equal(current.shell.snapshot().state, 'failed');
    assert.equal(current.shell.snapshot().errorLogId, 'shell-first-log');
    assert.equal(current.target.querySelector('input'), original);
    assert.equal(original?.value, '原外壳草稿');
    current.shell.retry();
    await settled(() => current.shell.snapshot().state === 'ready');
    assert.equal(attempts, 2);
    assert.equal(current.target.textContent, '显式重新打开成功');
  } finally { await current.dispose(); }
});

test('已选外壳仍在激活时只等待当前提供者就绪，不受其他插件通知影响', async () => {
  const current = fixture();
  const entered = deferred<void>(), activation = deferred<void>();
  let mounts = 0;
  try {
    const plugin: WebPlugin = {
      id: 'delayed_shell', version: '1.0.0', apiVersion: 2, panels: [],
      async activate(context) {
        context.ui?.register({ views: [{
          id: 'delayed_shell.root', title: '晚到外壳', provides: ['host.shell'],
          mount: async (target) => { mounts++; target.textContent = '当前外壳已就绪'; return () => {}; },
        }] });
        context.extensions?.points?.contribute({
          id: 'delayed_shell.shell', point: SHELL_POINT, mode: 'replace',
          data: { pluginId: 'delayed_shell', viewId: 'delayed_shell.root' },
        });
        entered.resolve();
        await activation.promise;
      },
    };
    current.runtime.bundledPlugins.register({ id: plugin.id, trusted: true, plugin });
    const loading = current.runtime.webPlugins.load(plugin.id);
    await entered.promise;
    current.runtime.host.extensions?.points?.select(SHELL_POINT, 'delayed_shell.shell');
    assert.equal(current.shell.snapshot().state, 'preparing');
    await current.add('unrelated_shell', async () => () => {});
    assert.equal(mounts, 0);
    activation.resolve();
    await loading;
    await settled(() => current.shell.snapshot().state === 'ready');
    assert.equal(mounts, 1);
    assert.equal(current.target.textContent, '当前外壳已就绪');
  } finally { activation.resolve(); await current.dispose(); }
});

test('外壳失败保留本次日志ID，无日志的新失败及成功不借用旧ID', async () => {
  const current = fixture();
  try {
    await current.add('shell_logged', async () => {
      throw new HostError('http', 'render_failed', '本次挂载失败', 'shell-render-log', 500);
    });
    current.runtime.host.extensions?.points?.select(SHELL_POINT, 'shell_logged.shell');
    await settled(() => current.shell.snapshot().state === 'failed');
    assert.equal(current.shell.snapshot().errorLogId, 'shell-render-log');
    await current.add('shell_unknown', async () => { throw new Error('本地失败没有日志 ID'); });
    current.runtime.host.extensions?.points?.select(SHELL_POINT, 'shell_unknown.shell');
    await settled(() => current.shell.snapshot().requested === 'shell_unknown.shell' && current.shell.snapshot().state === 'failed');
    assert.equal(current.shell.snapshot().errorLogId, null);
    await current.add('shell_ready', async () => () => {});
    current.runtime.host.extensions?.points?.select(SHELL_POINT, 'shell_ready.shell');
    await settled(() => current.shell.snapshot().state === 'ready');
    assert.equal(current.shell.snapshot().errorLogId, null);
  } finally { await current.dispose(); }
});

test('准备中的外壳被换选时，晚到释放不能拆除新外壳', async () => {
  const current = fixture();
  const entered = deferred<void>(), late = deferred<() => void>();
  try {
    await current.add('shell_a', async (target) => {
      target.textContent = '晚到甲';
      entered.resolve();
      return late.promise;
    });
    await current.add('shell_b', async (target) => { target.textContent = '当前乙'; return () => {}; });
    current.runtime.host.extensions?.points?.select(SHELL_POINT, 'shell_a.shell');
    await entered.promise;
    current.runtime.host.extensions?.points?.select(SHELL_POINT, 'shell_b.shell');
    await settled(() => current.shell.snapshot().active?.pluginId === 'shell_b');
    late.resolve(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(current.target.textContent, '当前乙');
    assert.equal(current.shell.snapshot().state, 'ready');
  } finally { late.resolve(() => {}); await current.dispose(); }
});

test('卸载外壳同步撤销显示并暴露空恢复态，同一已选提供者恢复后按原意图重挂', async () => {
  const current = fixture();
  try {
    await current.add('shell_a', async (target) => { target.textContent = '甲外壳'; return () => {}; });
    current.runtime.host.extensions?.points?.select(SHELL_POINT, 'shell_a.shell');
    await settled(() => current.shell.snapshot().state === 'ready');
    await current.runtime.webPlugins.unload('shell_a');
    assert.equal(current.target.textContent, '');
    assert.equal(current.shell.snapshot().active, null);
    assert.equal(current.shell.snapshot().state, 'empty');
    await current.runtime.webPlugins.load('shell_a');
    await settled(() => current.shell.snapshot().state === 'ready');
    assert.equal(current.target.textContent, '甲外壳');
    assert.equal(current.runtime.host.extensions?.points?.selected(SHELL_POINT)?.id, 'shell_a.shell');
  } finally { await current.dispose(); }
});

test('公开恢复入口展开收起不卸载外壳、不丢局部草稿', async () => {
  const current = fixture();
  let mounts = 0;
  try {
    await current.add('shell_a', async (target) => {
      mounts++;
      const input = target.ownerDocument.createElement('input');
      input.value = '尚未保存的草稿';
      target.append(input);
      return () => {};
    });
    current.runtime.host.extensions?.points?.select(SHELL_POINT, 'shell_a.shell');
    await settled(() => current.shell.snapshot().state === 'ready');
    const input = current.target.querySelector('input');
    const services = current.runtime.host.services;
    assert.ok(services);
    const ref = { id: 'host.platform.recovery', version: '1' };
    await services.call(ref, { action: 'open' }, current.runtime.host.signal);
    assert.equal(current.runtime.recovery.snapshot().open, true);
    await services.call(ref, { action: 'close' }, current.runtime.host.signal);
    assert.equal(current.runtime.recovery.snapshot().open, false);
    assert.equal(current.target.querySelector('input'), input);
    assert.equal(input?.value, '尚未保存的草稿');
    assert.equal(mounts, 1);
  } finally { await current.dispose(); }
});
