import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendRuntime } from '../src/app/runtime.ts';
import { createTerminalServices } from '../plugins/terminal/src/services.ts';
import type { TerminalServices } from '../plugins/terminal/src/services.ts';
import { createTerminalInstances } from '../plugins/terminal/src/instances.ts';
import createTerminalPlugin from '../plugins/terminal/src/index.ts';
import { createTerminalOwnership } from '../plugins/terminal/src/model/ownership.ts';
import { requireJson } from '@deviceforge/business-kit/jobs';
import { HostError } from '../src/plugin-sdk/index.ts';
import type { SessionInfo } from '../plugins/terminal/src/model/index.ts';
import type { CleanupContext, HostContext } from '../src/plugin-sdk/index.ts';
import { deferred, failure, requestUrl, signal, success } from './fixtures.ts';

const ownId = '12345678-1234-1234-1234-123456789abc';
const nextId = '22345678-1234-1234-1234-123456789abc';
const foreignId = '32345678-1234-1234-1234-123456789abc';
const info = (id: string, changes: Partial<SessionInfo> = {}): SessionInfo => ({
  id, operation: 'plugin.terminal.open', plugin_id: 'terminal', generation: 'server-generation',
  created_at: 1, status: 'opening', output_sequence: 0, completion: null, ...changes,
});
const complete = (session: SessionInfo): SessionInfo => ({
  ...session, status: 'finished',
  completion: { cleanup: 'complete', process_exited: true, sequence: 1, outcome: null, failure: null },
});
async function fixture(activate: (context: HostContext) => void | Promise<void>) {
  const records = new Map<string, SessionInfo>([[foreignId, info(foreignId, { status: 'running' })]]);
  const calls: { method: string; path: string; aborted: boolean }[] = [];
  const releases: string[] = [];
  const contexts: HostContext[] = [];
  const control = { lostOpen: false };
  let opened = 0;
  const runtime = createFrontendRuntime({
    baseUrl: 'http://127.0.0.1:7031', panelTarget: () => null, workspaceStorage: null,
    transport: async (input, init) => {
      const url = requestUrl(input), method = init?.method ?? 'GET', path = url.pathname;
      calls.push({ method, path, aborted: init?.signal?.aborted ?? false });
      if (path === '/api/v2/session-definitions') return success({
        revision: 1, sessions: [{
          id: 'plugin.terminal.open', title: '终端', input_schema: { type: 'object' },
          execution: { api_version: 1, source: 'declared', total_timeout_ms: 1000 },
        }],
      }, 'definitions-log');
      if (path === '/api/v2/sessions') {
        if (method === 'GET') return success([...records.values()], 'records-log');
        const session = info(opened++ === 0 ? ownId : nextId);
        records.set(session.id, session);
        return control.lostOpen ? failure('open_result_unknown', 503) : success(session, 'open-log');
      }
      const id = path.split('/')[4];
      const session = id ? records.get(id) : undefined;
      assert.ok(session, `未预期请求：${method} ${path}`);
      if (path.endsWith('/release')) {
        releases.push(session.id);
        const finished = complete(session);
        records.set(session.id, finished);
        return success(finished, 'release-log');
      }
      if (method === 'GET') return success(session, 'query-log');
      throw new Error(`未预期请求：${method} ${path}`);
    },
  });
  runtime.bundledPlugins.register({
    id: 'terminal_test', trusted: true,
    plugin: {
      id: 'terminal_test', version: '1', apiVersion: 2, panels: [],
      async activate(context) { contexts.push(context); await activate(context); },
    },
  });
  await runtime.webPlugins.load('terminal_test');
  return { runtime, records, calls, releases, contexts, control };
}
async function open(services: TerminalServices) {
  await services.sessions.refreshDefinitions(signal());
  return services.sessions.openPtyTerminal('powershell', { cols: 80, rows: 25 }, signal());
}
async function until(predicate: () => boolean) {
  for (let count = 0; count < 100 && !predicate(); count++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(predicate(), '有界清理没有收敛');
}

test('真实管理器卸载使用独立清理通路，只释放已确认打开的本实例会话', async () => {
  const services: TerminalServices[] = [];
  const f = await fixture((context) => { services.push(createTerminalServices(context)); });
  const current = services[0], context = f.contexts[0];
  assert.ok(current && context?.transport);
  try {
    await open(current);
    await current.sessions.refreshRecords(signal());
    assert.equal(current.owned().length, 1);
    current.sessions.clear();
    assert.equal(current.owned().length, 1, '清除前台选择不丢弃已经归属的后台资源');
    await f.runtime.webPlugins.unload('terminal_test');
    assert.equal(context.signal.aborted, true);
    assert.deepEqual(f.releases, [ownId]);
    assert.equal(f.records.get(foreignId)?.status, 'running');
    assert.equal(f.calls.some((call) => call.aborted), false, '释放派发不能沿用已撤销业务信号');
    const count = f.calls.length;
    await assert.rejects(async () => context.transport?.request({ path: '/api/v2/sessions' }, signal()),
      { kind: 'cancelled' });
    assert.equal(f.calls.length, count);
    assert.equal(current.sessions.snapshot().session, null);
  } finally { await f.runtime.dispose(); }
});

test('手动释放与随后自动卸载幂等，不重复派发释放', async () => {
  const services: TerminalServices[] = [];
  const f = await fixture((context) => { services.push(createTerminalServices(context)); });
  const current = services[0];
  assert.ok(current);
  try {
    await open(current);
    const first = current.dispose(), next = current.dispose();
    assert.equal(first, next);
    await first;
    await f.runtime.webPlugins.unload('terminal_test');
    assert.deepEqual(f.releases, [ownId]);
  } finally { await f.runtime.dispose(); }
});

test('打开结果未知保留原日志并显式查询记录，不取得未知记录归属或扫停其他终端', async () => {
  const services: TerminalServices[] = [];
  const f = await fixture((context) => { services.push(createTerminalServices(context)); });
  const current = services[0];
  assert.ok(current);
  try {
    f.control.lostOpen = true;
    await assert.rejects(async () => open(current), { code: 'open_result_unknown', logId: 'log-error' });
    assert.equal(current.sessions.snapshot().logs.open, 'log-error');
    assert.equal(current.sessions.snapshot().session, null);
    assert.deepEqual(current.owned(), []);
    await current.sessions.refreshRecords(signal());
    assert.equal(current.sessions.snapshot().records.length, 2);
    await f.runtime.webPlugins.unload('terminal_test');
    assert.deepEqual(f.releases, []);
    assert.equal(f.calls.filter((call) => call.method === 'POST' && call.path === '/api/v2/sessions').length, 1);
    assert.equal(f.records.get(ownId)?.status, 'opening');
  } finally { await f.runtime.dispose(); }
});

test('缺少有界清理能力的旧宿主不能登记独立终端页面', async () => {
  const f = await fixture(async (context) => {
    const { onCleanup: _cleanup, ...legacy } = context;
    const plugin = createTerminalPlugin({ id: 'terminal_test', version: '1', apiVersion: 2 });
    await assert.rejects(async () => plugin.activate?.(legacy), /有界清理/);
    assert.equal(context.ui?.catalog().pages.some((page) => page.route === '/terminal'), false);
  });
  try { assert.deepEqual(f.calls, []); }
  finally { await f.runtime.dispose(); }
});

test('多实例分别拥有会话，隐藏保留草稿，关闭一个实例不释放另一个', async () => {
  const pools: ReturnType<typeof createTerminalInstances>[] = [];
  const f = await fixture((context) => {
    context.ui?.register({
      workspaces: [{ id: 'terminal_test.workspace', title: '终端' }],
      views: [{ id: 'terminal_test.view', title: '终端', mount: async () => () => {} }],
    });
    pools.push(createTerminalInstances(context, 'terminal_test'));
  });
  const pool = pools[0], context = f.contexts[0], ui = context?.ui;
  assert.ok(pool && ui);
  try {
    const first = pool.retain(ui.open({
      instanceId: 'terminal_test.one', workspaceId: 'terminal_test.workspace',
      provider: { pluginId: 'terminal_test', viewId: 'terminal_test.view' },
    }));
    const second = pool.retain(ui.open({
      instanceId: 'terminal_test.two', workspaceId: 'terminal_test.workspace',
      provider: { pluginId: 'terminal_test', viewId: 'terminal_test.view' },
    }));
    await open(first); await open(second);
    first.draft.profile = 'powershell'; first.draft.raw = true;
    const hidden = ui.setVisible('terminal_test.one', false);
    assert.equal(pool.retain(hidden), first);
    assert.equal(first.draft.profile, 'powershell');
    assert.equal(first.draft.raw, true);
    assert.deepEqual(f.releases, []);
    ui.close('terminal_test.one');
    await until(() => f.releases.length === 1);
    assert.deepEqual(f.releases, [ownId]);
    assert.equal(second.sessions.snapshot().session?.id, nextId);
    await f.runtime.webPlugins.unload('terminal_test');
    assert.deepEqual(f.releases, [ownId, nextId]);
  } finally { await f.runtime.dispose(); }
});

test('清理先核对完整归属，错误代次与超时不误派发释放或无限等待', async () => {
  const owner = createTerminalOwnership();
  owner.record(info(ownId));
  const calls: string[] = [];
  const cleanup: CleanupContext = {
    signal: signal(), deadline: Date.now() + 1000,
    transport: { async request(request) {
      calls.push(request.path);
      return { data: requireJson({ ...info(ownId), generation: 'other-generation' }), logId: 'wrong-generation-log' };
    } },
  };
  await assert.rejects(owner.release(cleanup), { code: 'invalid_session_response', logId: 'wrong-generation-log' });
  assert.equal(calls.some((path) => path.endsWith('/release')), false);
  const blocked = createTerminalOwnership(), waiting = deferred<never>();
  blocked.record(info(ownId));
  await assert.rejects(blocked.release({
    signal: signal(), deadline: Date.now() + 20,
    transport: { request: () => waiting.promise },
  }), { code: 'terminal_cleanup_timeout' });
  waiting.reject(new Error('已结束等待后的晚拒绝'));
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test('Stopping只作释放回执，继续只读查询Finished和真实清理证据', async () => {
  const owner = createTerminalOwnership();
  owner.record(info(ownId));
  let reads = 0, releases = 0;
  await owner.release({
    signal: signal(), deadline: Date.now() + 1000,
    transport: { async request(request) {
      if (request.path.endsWith('/release')) {
        releases++;
        return { data: requireJson(info(ownId, { status: 'stopping' })), logId: 'release-log' };
      }
      const current = ++reads < 3
        ? info(ownId, { status: reads === 1 ? 'running' : 'stopping' }) : complete(info(ownId));
      return { data: requireJson(current), logId: `query-${reads}` };
    } },
  });
  assert.equal(releases, 1);
  assert.equal(reads, 3);
  assert.deepEqual(owner.snapshot(), []);
});

test('释放结果未知保留原错误与日志，不重发释放，也不误记为清理成功', async () => {
  const owner = createTerminalOwnership();
  owner.record(info(ownId));
  let reads = 0, releases = 0;
  await assert.rejects(owner.release({
    signal: signal(), deadline: Date.now() + 1000,
    transport: { async request(request) {
      if (request.path.endsWith('/release')) {
        releases++;
        throw new HostError('network', 'release_result_unknown', '释放响应失联', 'release-unknown-log');
      }
      reads++;
      return { data: requireJson(info(ownId, { status: 'running' })), logId: 'query-log' };
    } },
  }), { code: 'release_result_unknown', logId: 'release-unknown-log' });
  assert.equal(releases, 1);
  assert.equal(reads, 1);
  assert.equal(owner.snapshot().length, 1);
});
