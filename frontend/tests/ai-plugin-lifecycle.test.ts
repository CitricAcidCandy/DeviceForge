import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendRuntime } from '../src/app/runtime.ts';
import { createAiServices } from '../plugins/ai/src/services.ts';
import { createAiInstances } from '../plugins/ai/src/instances.ts';
import createAiPlugin from '../plugins/ai/src/index.ts';
import type { AiServices } from '../plugins/ai/src/services.ts';
import type { HostContext } from '../src/plugin-sdk/index.ts';
import { HostError } from '../src/plugin-sdk/index.ts';
import { createAiOwnership } from '../plugins/ai/src/model/ownership.ts';
import type { SessionInfo } from '../plugins/ai/src/model/api.ts';
import { isRecord } from '@deviceforge/business-kit/api';
import { JobWaitFailure, requireJson } from '@deviceforge/business-kit/jobs';
import { failure, requestUrl, signal, success } from './fixtures.ts';

const sdkId = '12345678-1234-1234-1234-123456789abc';
const cliId = '22345678-1234-1234-1234-123456789abc';
const nextSdkId = '42345678-1234-1234-1234-123456789abc';
const foreignId = '32345678-1234-1234-1234-123456789abc';
const sdkOperation = 'plugin.ai-sdk.sdk.stream', cliOperation = 'plugin.ai-assistant.cli.stream';
function session(id: string, operation = sdkOperation): SessionInfo {
  return { id, operation, plugin_id: operation === sdkOperation ? 'ai-sdk' : 'ai-assistant',
    generation: 'server-generation', created_at: 1, status: 'opening', output_sequence: 0, completion: null };
}
async function fixture(activate: (context: HostContext) => void | Promise<void>) {
  const records = new Map<string, SessionInfo>([[foreignId, { ...session(foreignId), status: 'running' }]]);
  const jobs = new Map<string, { id: string; operation: string; status: string; error: null; result: null }>();
  const calls: { method: string; path: string; aborted: boolean }[] = [];
  const released: string[] = [], cancelled: string[] = [];
  const control = { unknownOpen: false, unknownSubmit: false };
  const contexts: HostContext[] = [];
  const runtime = createFrontendRuntime({
    baseUrl: 'http://127.0.0.1:7031', workspaceStorage: null, panelTarget: () => null,
    transport: async (input, init) => {
      const path = requestUrl(input).pathname, method = init?.method ?? 'GET';
      calls.push({ method, path, aborted: init?.signal?.aborted ?? false });
      if (path === '/api/v2/operations') return success([
        ...['runtime.status', 'sdk.single', 'sdk.turn', 'session.get', 'session.close', 'assistant.run']
          .map((action) => ({ id: `plugin.ai-sdk.${action}`, title: action, input_schema: { type: 'object' } })),
        ...['runtime.status', 'cli.single', 'cli.turn', 'session.get', 'session.close']
          .map((action) => ({ id: `plugin.ai-assistant.${action}`, title: action, input_schema: { type: 'object' } })),
      ], 'operations-log');
      if (path === '/api/v2/session-definitions') return success({
        revision: 1, sessions: [sdkOperation, cliOperation].map((id) => ({
          id, title: id, input_schema: { type: 'object' },
          execution: { api_version: 1, source: 'declared', total_timeout_ms: 1000 },
        })),
      }, 'definitions-log');
      if (path === '/api/v2/sessions') {
        if (method === 'GET') return success([...records.values()], 'records-log');
        const body: unknown = JSON.parse(String(init?.body));
        assert.ok(isRecord(body));
        const id = body.operation === sdkOperation ? (records.has(sdkId) ? nextSdkId : sdkId) : cliId;
        const record = session(id, String(body.operation));
        records.set(record.id, record);
        return control.unknownOpen ? failure('open_unknown', 503) : success(record, 'open-log');
      }
      if (path === '/api/v2/jobs' && method === 'POST') {
        const body: unknown = JSON.parse(String(init?.body));
        assert.ok(isRecord(body) && typeof body.operation === 'string');
        const job = { id: `job-${jobs.size}`, operation: body.operation, status: 'running', error: null, result: null };
        jobs.set(job.id, job);
        return control.unknownSubmit ? failure('submit_unknown', 503) : success(job, 'submit-log');
      }
      if (path.startsWith('/api/v2/jobs/')) {
        const id = path.split('/')[4], job = id ? jobs.get(id) : undefined;
        assert.ok(job);
        if (path.endsWith('/cancel')) { cancelled.push(job.id); job.status = 'cancelled'; }
        return success(job, path.endsWith('/cancel') ? 'cancel-log' : 'job-log');
      }
      const id = path.split('/')[4], record = id ? records.get(id) : undefined;
      assert.ok(record, `未预期的请求：${method} ${path}`);
      if (path.endsWith('/release')) {
        released.push(record.id);
        const finished: SessionInfo = { ...record, status: 'finished', completion: {
          cleanup: 'complete', process_exited: true, sequence: 1, outcome: null, failure: null,
        } };
        records.set(record.id, finished);
        return success(finished, 'release-log');
      }
      return success(record, 'query-log');
    },
  });
  runtime.bundledPlugins.register({ id: 'ai_test', trusted: true, plugin: {
    id: 'ai_test', version: '1', apiVersion: 2, panels: [],
    async activate(context) { contexts.push(context); await activate(context); },
  } });
  await runtime.webPlugins.load('ai_test');
  return { runtime, records, jobs, calls, released, cancelled, control, contexts };
}
async function until(predicate: () => boolean) {
  for (let count = 0; count < 100 && !predicate(); count++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(predicate(), '受理回执未在单元夹具内收敛');
}

test('真实卸载通过独立清理信号只释放本实例流与已接受Job，不扫停恢复记录', async () => {
  const rows: AiServices[] = [];
  const f = await fixture((context) => { rows.push(createAiServices(context)); });
  const services = rows[0];
  assert.ok(services);
  try {
    await services.sdkStreaming.refreshDefinitions(signal());
    await services.sdkStreaming.open({ project_id: 'demo', prompt: '测试' }, signal());
    await services.sdkStreaming.resume(foreignId, { project_id: 'demo' }, signal());
    await services.sdk.refreshOperations(signal());
    const waiting = new AbortController();
    const job = services.sdk.single({ project_id: 'demo', prompt: '不重发' }, waiting.signal);
    const stopped = assert.rejects(job, JobWaitFailure);
    await until(() => f.jobs.size === 1);
    waiting.abort();
    await stopped;
    await f.runtime.webPlugins.unload('ai_test');
    assert.deepEqual(f.released, [sdkId]);
    assert.deepEqual(f.cancelled, ['job-0']);
    assert.equal(f.records.get(foreignId)?.status, 'running');
    assert.equal(f.calls.some((call) => call.aborted), false);
  } finally { await f.runtime.dispose(); }
});

test('未知打开和未知任务提交保留原日志，不认领、重提或按目录扫停', async () => {
  const rows: AiServices[] = [];
  const f = await fixture((context) => { rows.push(createAiServices(context)); });
  const services = rows[0];
  assert.ok(services);
  try {
    f.control.unknownOpen = true; f.control.unknownSubmit = true;
    await services.sdkStreaming.refreshDefinitions(signal());
    await assert.rejects(services.sdkStreaming.open({ project_id: 'demo', prompt: '只提交一次' }, signal()),
      { code: 'open_unknown', logId: 'log-error' });
    await services.sdk.refreshOperations(signal());
    await assert.rejects(services.sdk.single({ project_id: 'demo', prompt: '只提交一次' }, signal()),
      { code: 'submit_unknown', logId: 'log-error' });
    await services.sdkStreaming.refreshRecords(signal());
    await f.runtime.webPlugins.unload('ai_test');
    assert.deepEqual(f.released, []);
    assert.deepEqual(f.cancelled, []);
    assert.equal(f.calls.filter((call) => call.method === 'POST' && call.path === '/api/v2/sessions').length, 1);
    assert.equal(f.calls.filter((call) => call.method === 'POST' && call.path === '/api/v2/jobs').length, 1);
  } finally { await f.runtime.dispose(); }
});

test('目标切换隔离SDK旧观测并独立回收旧资源，CLI和新目标不等待旧清理', async () => {
  const rows: AiServices[] = [];
  const f = await fixture((context) => { rows.push(createAiServices(context)); });
  const services = rows[0];
  assert.ok(services);
  try {
    await services.sdkStreaming.refreshDefinitions(signal());
    await services.cliStreaming.refreshDefinitions(signal());
    await services.sdkStreaming.open({ project_id: 'old', prompt: 'SDK' }, signal());
    await services.cliStreaming.open({ project_id: 'cli', prompt: 'CLI' }, signal());
    services.drafts.sdk.prompt = '保留草稿';
    services.changeTarget('sdk');
    assert.equal(services.sdkStreaming.snapshot().session, null);
    assert.equal(services.cliStreaming.snapshot().session?.id, cliId);
    assert.equal(services.drafts.sdk.prompt, '保留草稿');
    await services.sdkStreaming.refreshDefinitions(signal());
    await services.sdkStreaming.open({ project_id: 'new', prompt: '新目标' }, signal());
    await until(() => f.released.includes(sdkId));
    assert.equal(f.released.includes(cliId), false);
    assert.equal(f.released.includes(nextSdkId), false);
    assert.equal(services.sdkStreaming.snapshot().owner?.project_id, 'new');
    assert.equal(services.sdkStreaming.snapshot().session?.id, nextSdkId);
    await services.dispose();
    assert.deepEqual([...f.released].sort(), [sdkId, nextSdkId, cliId].sort());
  } finally { await f.runtime.dispose(); }
});

test('实例隐藏保留模型和草稿，关闭一个实例不撤销其他实例；手动与卸载幂等', async () => {
  const pools: ReturnType<typeof createAiInstances>[] = [];
  const f = await fixture((context) => {
    context.ui?.register({
      workspaces: [{ id: 'ai_test.workspace', title: 'AI',
        defaultLayout: { version: 1, root: null, floating: [], overlays: [] } }],
      views: [{ id: 'ai_test.view', title: 'AI', mount: async () => () => {} }],
    });
    pools.push(createAiInstances(context, 'ai_test'));
  });
  const pool = pools[0], ui = f.contexts[0]?.ui;
  assert.ok(pool && ui);
  try {
    const one = ui.open({ instanceId: 'ai_test.one', workspaceId: 'ai_test.workspace',
      provider: { pluginId: 'ai_test', viewId: 'ai_test.view' } }, signal());
    const two = ui.open({ instanceId: 'ai_test.two', workspaceId: 'ai_test.workspace',
      provider: { pluginId: 'ai_test', viewId: 'ai_test.view' } }, signal());
    const first = pool.retain(one), second = pool.retain(two);
    first.drafts.sdk.prompt = '第一份'; second.drafts.sdk.prompt = '第二份';
    await first.sdkStreaming.refreshDefinitions(signal());
    await first.sdkStreaming.open({ project_id: 'one', prompt: '一' }, signal());
    await second.cliStreaming.refreshDefinitions(signal());
    await second.cliStreaming.open({ project_id: 'two', prompt: '二' }, signal());
    ui.setVisible('ai_test.one', false);
    const hidden = ui.snapshot().instances.find((entry) => entry.instanceId === 'ai_test.one');
    assert.ok(hidden);
    assert.equal(pool.retain(hidden), first);
    assert.equal(first.drafts.sdk.prompt, '第一份');
    assert.deepEqual(f.released, []);
    ui.close('ai_test.one');
    await until(() => f.released.includes(sdkId));
    assert.equal(second.cliStreaming.snapshot().session?.id, cliId);
    assert.equal(second.drafts.sdk.prompt, '第二份');
    const closing = second.dispose();
    assert.equal(second.dispose(), closing);
    await closing;
    await f.runtime.webPlugins.unload('ai_test');
    assert.deepEqual([...f.released].sort(), [sdkId, cliId].sort());
  } finally { await f.runtime.dispose(); }
});

test('缺少有界清理能力时不登记AI页，不能以部分模型接管旧页面', async () => {
  const f = await fixture(async (context) => {
    const { onCleanup: _cleanup, ...unsupported } = context;
    const plugin = createAiPlugin({ id: 'missing_cleanup', version: '1', apiVersion: 2 });
    assert.throws(() => createAiServices(unsupported));
    await assert.rejects(Promise.resolve().then(() => plugin.activate?.(unsupported)), /有界清理/);
  });
  try {
    assert.equal(f.runtime.host.ui?.catalog().pages.some((page) => page.route === '/ai'), false);
    assert.equal(f.calls.length, 0);
  } finally { await f.runtime.dispose(); }
});

test('切换目标立即结束Job轮询间隔及流观测，旧任务不借新目标信号继续', async () => {
  const rows: AiServices[] = [];
  const f = await fixture((context) => { rows.push(createAiServices(context, { pollIntervalMs: 60000 })); });
  const services = rows[0];
  assert.ok(services);
  try {
    await services.sdk.refreshOperations(signal());
    const waiting = services.sdk.single({ project_id: 'old', prompt: '旧请求' }, signal());
    const cancelled = assert.rejects(waiting, JobWaitFailure);
    await until(() => services.owned().sdk.jobs.length === 1);
    services.changeTarget('sdk');
    await cancelled;
    assert.equal(f.calls.filter((call) => call.path === '/api/v2/jobs' && call.method === 'POST').length, 1);
    assert.equal(services.owned().sdk.jobs.length, 0);
    await until(() => f.cancelled.includes('job-0'));
  } finally { await f.runtime.dispose(); }
});

test('Stopping只是释放回执，后续只读查询真实终态；未知释放保留原日志且不重派', async () => {
  const owner = createAiOwnership('sdk'), record = session(sdkId);
  owner.recordStream(record, 'open-log');
  let releases = 0, reads = 0;
  await owner.release({ signal: signal(), deadline: Date.now() + 1000, transport: {
    async request(input) {
      if (input.method === 'POST') {
        releases++;
        return { data: requireJson({ ...record, status: 'stopping' }), logId: 'stopping-log' };
      }
      reads++;
      return { data: requireJson(reads < 3 ? { ...record, status: reads === 1 ? 'running' : 'stopping' } :
        { ...record, status: 'finished', completion: {
          cleanup: 'complete', process_exited: true, outcome: null, failure: null, sequence: 1,
        } }), logId: 'query-log' };
    },
  } });
  assert.equal(releases, 1); assert.equal(reads, 3);
  assert.equal(owner.snapshot().streams.length, 0);
  const unknown = createAiOwnership('sdk');
  unknown.recordStream(record, 'open-log');
  let attempts = 0;
  await assert.rejects(unknown.release({ signal: signal(), deadline: Date.now() + 1000, transport: {
    async request(input) {
      if (input.method === 'POST') { attempts++; throw new HostError('network', 'release_unknown', '释放响应失联', 'unknown-log'); }
      return { data: requireJson(record), logId: 'before-log' };
    },
  } }), { code: 'release_unknown', logId: 'unknown-log' });
  assert.equal(attempts, 1); assert.equal(unknown.snapshot().streams.length, 1);
});

test('归属换代或忽略取消的通信只产生有界失败，不误释放或污染新资源', async () => {
  const owner = createAiOwnership('sdk'), record = session(sdkId);
  owner.recordStream(record, 'open-log');
  assert.throws(() => owner.recordStream({ ...record, generation: 'another' }, 'duplicate-log'),
    { code: 'changed_ai_stream_owner', logId: 'duplicate-log' });
  let releases = 0;
  await assert.rejects(owner.release({ signal: signal(), deadline: Date.now() + 1000, transport: {
    async request(input) {
      if (input.method === 'POST') releases++;
      return { data: requireJson({ ...record, generation: 'another' }), logId: 'changed-log' };
    },
  } }), { code: 'changed_ai_stream_owner', logId: 'changed-log' });
  assert.equal(releases, 0);
  const blocked = createAiOwnership('sdk');
  blocked.recordStream(record, 'open-log');
  const start = Date.now();
  await assert.rejects(blocked.release({ signal: signal(), deadline: Date.now() + 20, transport: {
    request: () => new Promise<never>(() => {}),
  } }), { code: 'ai_cleanup_timeout' });
  assert.ok(Date.now() - start < 1000);
  assert.equal(blocked.snapshot().streams.length, 1);
});
