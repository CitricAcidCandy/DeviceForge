import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendRuntime } from '../src/app/runtime.ts';
import createAiPlugin from '../plugins/ai/src/index.ts';
import { createAiServices } from '../plugins/ai/src/services.ts';
import { HostError, JobWaitFailure } from '../src/plugin-sdk/index.ts';
import type { HostContext, JsonValue } from '../src/plugin-sdk/index.ts';
import { isRecord } from '@deviceforge/business-kit/api';
import { boundedServiceJson, serviceResult } from '../plugins/ai/src/public-services/contract.ts';
import { deferred, failure, requestUrl, signal, success } from './fixtures.ts';

const pluginId = 'public_ai', sdkId = `${pluginId}.sdk`, streamId = `${sdkId}.stream`;
const sessionId = '12345678-1234-1234-1234-123456789abc';
const viewSessionId = '22345678-1234-1234-1234-123456789abc';
const threadId = 'abcdef12-1234-1234-1234-123456789abc';
const operation = 'plugin.ai-sdk.sdk.stream';
const actions = ['runtime.status', 'sdk.single', 'sdk.turn', 'session.get', 'session.close', 'assistant.run'] satisfies string[];
function session(id = sessionId) {
  return { id, operation, plugin_id: 'ai-sdk', generation: 'server-generation',
    created_at: 1, status: 'opening', output_sequence: 0, completion: null };
}
function result(action: string) {
  if (action === 'runtime.status') return {
    provider: 'codex_sdk', sdk_version: '0.162.1', profile: 'codex_sdk_ts_0_162_1_node24',
    configured: true, node_version: '24.14.0', cli_version: '0.162.1', sdk_loaded: true,
    process_scope_qualified: true, model_verified: false, ready: true, projects: ['demo'],
    reason: null, resource_scope: 'sdk_worker_proxy_and_cli',
  };
  if (action === 'session.get' || action === 'session.close') return {
    provider: 'codex_sdk', sdk_version: '0.162.1', profile: 'codex_sdk_ts_0_162_1_node24',
    project_id: 'demo', thread_id: threadId, turns: '1', closed: action === 'session.close',
    uncertain: false, resource_scope: 'sdk_worker_proxy_and_cli',
  };
  return {
    provider: 'codex_sdk', sdk_version: '0.162.1', project_id: 'demo', thread_id: threadId,
    text: '完成', turns: action === 'sdk.turn' ? '2' : action === 'assistant.run' ? '4' : '1',
    resource_scope: 'sdk_worker_proxy_and_cli',
    ...(action === 'assistant.run' ? { assistant_turns: '4', stream_output: false } : {}),
  };
}
function request(action: string): JsonValue {
  if (action === 'runtime.status') return { action };
  if (action === 'session.get' || action === 'session.close')
    return { action, input: { project_id: 'demo', thread_id: threadId.toUpperCase() } };
  if (action === 'assistant.run')
    return { action, input: { project_id: 'demo', user_prompt: '完成', stream_output: false } };
  return { action, input: { project_id: 'demo', prompt: '原提示词',
    ...(action === 'sdk.turn' ? { thread_id: threadId.toUpperCase() } : {}) } };
}
async function fixture(transport?: typeof fetch) {
  const calls: { method: string; path: string; body: unknown; aborted: boolean }[] = [];
  const completed = new Set<string>(), released: string[] = [];
  const control = { opens: 0 };
  const defaultTransport: typeof fetch = async (input, init) => {
    const path = requestUrl(input).pathname, method = init?.method ?? 'GET';
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path, method, body, aborted: init?.signal?.aborted ?? false });
    if (path === '/api/v2/operations')
      return success(actions.map((action) => ({ id: `plugin.ai-sdk.${action}`, title: action, input_schema: { type: 'object' } })), 'catalog-log');
    if (path === '/api/v2/jobs' && method === 'POST') {
      assert.ok(isRecord(body) && typeof body.operation === 'string');
      return success({ id: `job-${calls.length}`, operation: body.operation, status: 'succeeded',
        result: { result: result(body.operation.replace('plugin.ai-sdk.', '')), artifacts: [] } }, 'job-log');
    }
    if (path === '/api/v2/session-definitions') return success({ revision: 1, sessions: [{
      id: operation, title: 'SDK', input_schema: { type: 'object' },
      execution: { api_version: 1, source: 'declared', total_timeout_ms: 1000 },
    }] }, 'definitions-log');
    if (path === '/api/v2/sessions' && method === 'GET') return success([session()], 'records-log');
    if (path === '/api/v2/sessions' && method === 'POST')
      return success(session(control.opens++ === 0 ? sessionId : viewSessionId), 'open-log');
    const id = path.split('/')[4] ?? sessionId;
    if (path.endsWith('/output')) return success({ session: session(id), next_sequence: 0, chunks: [] }, 'output-log');
    if (path.endsWith('/cancel')) return success({ ...session(id), status: 'stopping' }, 'cancel-log');
    if (path.endsWith('/release')) { released.push(id); completed.add(id); }
    if (path.startsWith('/api/v2/sessions/')) return success(completed.has(id) ?
      { ...session(id), status: 'finished', completion: {
        cleanup: 'complete', process_exited: true, sequence: 1, outcome: null, failure: null,
      } } : session(id), 'query-log');
    throw new Error(`未预期请求：${method} ${path}`);
  };
  const runtime = createFrontendRuntime({ baseUrl: 'http://127.0.0.1:7031', workspaceStorage: null,
    panelTarget: () => null, transport: transport ?? defaultTransport });
  runtime.bundledPlugins.register({ id: pluginId, trusted: true,
    plugin: createAiPlugin({ id: pluginId, version: '1', apiVersion: 2 }) });
  await runtime.webPlugins.load(pluginId);
  const extensions = runtime.host.extensions;
  assert.ok(extensions);
  const call = (id: string, value: JsonValue, current = signal()) =>
    extensions.callService(id, '1', value, current);
  return { runtime, calls, released, call, control };
}
async function until(predicate: () => boolean) {
  for (let count = 0; count < 100 && !predicate(); count++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(predicate(), '调用没有在有界单元夹具内开始');
}

test('真实插件激活仅登记命名空间服务，按需调用且不抢注册host旧ID', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(f.calls, []);
    const entries = f.runtime.host.extensions?.catalog().services.filter((entry) => entry.pluginId === pluginId);
    assert.deepEqual(entries?.map((entry) => [entry.id, entry.version]).sort(),
      [[sdkId, '1'], [streamId, '1']].sort());
    const snapshot = await f.call(streamId, { action: 'snapshot' });
    assert.ok(isRecord(snapshot.data) && snapshot.data.session === null);
    assert.equal(f.calls.length, 0);
  } finally { await f.runtime.dispose(); }
});

test('普通服务完整六动作复用公开模型，UUID规范化且只返回业务结果与最终日志', async () => {
  const f = await fixture();
  try {
    for (const action of actions) {
      const response = await f.call(sdkId, request(action));
      assert.deepEqual(response.data, result(action));
      assert.equal(response.logId, 'job-log');
    }
    assert.equal(f.calls.filter((call) => call.path === '/api/v2/operations').length, 1);
    assert.equal(f.calls.filter((call) => call.method === 'POST' && call.path === '/api/v2/jobs').length, 6);
    assert.ok(f.calls.some(({ body }) => isRecord(body) && isRecord(body.input) && body.input.thread_id === threadId));
  } finally { await f.runtime.dispose(); }
});

test('服务严格动作、字段、输入和一MiB请求限制；无效请求不派发业务', async () => {
  const f = await fixture();
  try {
    const invalid: JsonValue[] = [
      null, [], { action: 'unknown' }, { action: 'runtime.status', input: {} },
      { action: 'sdk.single', input: { project_id: '../demo', prompt: '你好' } },
      { action: 'sdk.single', input: { project_id: 'demo', prompt: ' ' } },
      { action: 'assistant.run', input: { project_id: 'demo', thread_id: threadId } },
    ];
    for (const value of invalid) await assert.rejects(f.call(sdkId, value),
      (error: unknown) => error instanceof HostError && error.kind === 'protocol');
    for (const value of [
      { action: 'definitions', extra: true }, { action: 'open', input: { project_id: 'demo', prompt: '你好', extra: true } },
      { action: 'resume', id: 'bad', owner: { project_id: 'demo' } }, { action: 'output', limit: 101 },
    ]) await assert.rejects(f.call(streamId, value),
      (error: unknown) => error instanceof HostError && error.kind === 'protocol');
    for (const id of [sdkId, streamId]) await assert.rejects(f.call(id,
      { action: 'snapshot', extra: '字'.repeat(350000) }), { code: 'ai_sdk_service_limit' });
    assert.equal(f.calls.length, 0);
  } finally { await f.runtime.dispose(); }
});

test('流服务十动作保留会话身份、日志、Stopping及clear语义，不生成业务假进度', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call(streamId, { action: 'definitions' })).logId, 'definitions-log');
    assert.equal((await f.call(streamId, { action: 'records' })).logId, 'records-log');
    assert.equal((await f.call(streamId, { action: 'open', input: { project_id: 'demo', prompt: '你好' } })).logId, 'open-log');
    assert.equal((await f.call(streamId, { action: 'query' })).logId, 'query-log');
    assert.equal((await f.call(streamId, { action: 'output', limit: 10 })).logId, 'output-log');
    const cancelled = await f.call(streamId, { action: 'cancel' });
    assert.ok(isRecord(cancelled.data) && cancelled.data.status === 'stopping');
    const snapshot = await f.call(streamId, { action: 'snapshot' });
    assert.ok(isRecord(snapshot.data) && isRecord(snapshot.data.session) && snapshot.data.session.status === 'stopping');
    const cleared = await f.call(streamId, { action: 'clear' });
    assert.ok(isRecord(cleared.data) && cleared.data.session === null);
    await f.call(streamId, { action: 'resume', id: sessionId, owner: { project_id: 'demo' } });
    const controller = new AbortController();
    const pending = f.call(streamId, { action: 'poll', limit: 10 }, controller.signal);
    const ended = assert.rejects(pending, (error: unknown) => error instanceof HostError && error.kind === 'cancelled');
    controller.abort(); await ended;
    assert.equal(f.calls.filter(({ path, method }) => path === '/api/v2/sessions' && method === 'POST').length, 1);
  } finally { await f.runtime.dispose(); }
});

test('普通和流服务保留HTTP错误日志，流快照只序列化公开错误字段', async () => {
  const f = await fixture(async () => failure('catalog_unavailable', 503));
  try {
    await assert.rejects(f.call(sdkId, { action: 'runtime.status' }),
      { kind: 'http', code: 'catalog_unavailable', logId: 'log-error', status: 503 });
    await assert.rejects(f.call(streamId, { action: 'definitions' }),
      { kind: 'http', code: 'catalog_unavailable', logId: 'log-error', status: 503 });
    const observed = (await f.call(streamId, { action: 'snapshot' })).data;
    assert.ok(isRecord(observed) && isRecord(observed.errors) && isRecord(observed.errors.definitions));
    assert.deepEqual(Object.keys(observed.errors.definitions).sort(),
      ['kind', 'code', 'message', 'logId', 'status', 'retryAfter'].sort());
    assert.equal(observed.errors.definitions.logId, 'log-error');
    assert.equal(observed.errors.definitions instanceof Error, false);
  } finally { await f.runtime.dispose(); }
});

test('已接受任务等待失败保留原Job与提交日志，unknown提交和Open不自动重放或认领', async () => {
  const calls: string[] = [];
  const control = { submitUnknown: true, recovered: false };
  const f = await fixture(async (input, init) => {
    const path = requestUrl(input).pathname;
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (path === '/api/v2/operations')
      return success(actions.map((action) => ({ id: `plugin.ai-sdk.${action}`, title: action, input_schema: { type: 'object' } })), 'catalog-log');
    if (path === '/api/v2/jobs') return control.submitUnknown ? failure('submit_unknown', 503) :
      success({ id: 'accepted', operation: 'plugin.ai-sdk.sdk.single', status: 'running' }, 'submit-log');
    if (path === '/api/v2/jobs/accepted') return control.recovered ?
      success({ id: 'accepted', operation: 'plugin.ai-sdk.sdk.single', status: 'cancelled' }, 'confirmed-log') :
      failure('query_unknown', 503);
    if (path === '/api/v2/session-definitions') return success({ revision: 1, sessions: [{
      id: operation, title: 'SDK', input_schema: { type: 'object' },
      execution: { api_version: 1, source: 'declared', total_timeout_ms: 1000 },
    }] });
    if (path === '/api/v2/sessions') return failure('open_unknown', 503);
    throw new Error(`未知结果后不能自动重放：${path}`);
  });
  try {
    await assert.rejects(f.call(sdkId, request('sdk.single')), { code: 'submit_unknown', logId: 'log-error' });
    await f.call(streamId, { action: 'definitions' });
    await assert.rejects(f.call(streamId, { action: 'open', input: { project_id: 'demo', prompt: '不重发' } }),
      { code: 'open_unknown', logId: 'log-error' });
    const unknownSnapshot = (await f.call(streamId, { action: 'snapshot' })).data;
    assert.ok(isRecord(unknownSnapshot) && unknownSnapshot.session === null);
    control.submitUnknown = false;
    await assert.rejects(f.call(sdkId, request('sdk.single')), (error: unknown) => {
      assert.ok(error instanceof JobWaitFailure);
      assert.equal(error.job.id, 'accepted');
      assert.equal(error.submitLogId, 'submit-log');
      assert.equal(error.logId, 'log-error');
      assert.equal(error.lastKnownLogId, 'submit-log');
      return true;
    });
    assert.equal(calls.filter((call) => call === 'POST /api/v2/jobs').length, 2);
    assert.equal(calls.filter((call) => call === 'POST /api/v2/sessions').length, 1);
  } finally {
    control.recovered = true;
    await f.runtime.dispose();
  }
});

test('公共服务模型与页面实例隔离，提供者卸载只释放自己的服务会话', async () => {
  const f = await fixture();
  const views: ReturnType<typeof createAiServices>[] = [];
  f.runtime.bundledPlugins.register({ id: 'separate_ai_view', trusted: true, plugin: {
    id: 'separate_ai_view', version: '1', apiVersion: 2, panels: [],
    async activate(context) { views.push(createAiServices(context)); },
  } });
  await f.runtime.webPlugins.load('separate_ai_view');
  try {
    await f.call(streamId, { action: 'definitions' });
    await f.call(streamId, { action: 'open', input: { project_id: 'service', prompt: '服务会话' } });
    const current = views[0];
    assert.ok(current);
    await current.sdkStreaming.refreshDefinitions(signal());
    await current.sdkStreaming.open({ project_id: 'view', prompt: '页面会话' }, signal());
    const snapshot = (await f.call(streamId, { action: 'snapshot' })).data;
    assert.ok(isRecord(snapshot) && isRecord(snapshot.session) && snapshot.session.id === sessionId);
    assert.equal(current.sdkStreaming.snapshot().session?.id, viewSessionId);
    await f.runtime.webPlugins.unload(pluginId);
    assert.deepEqual(f.released, [sessionId]);
    assert.equal(current.sdkStreaming.snapshot().session?.id, viewSessionId);
    await assert.rejects(Promise.resolve().then(() => f.call(streamId, { action: 'snapshot' })),
      { code: 'service_unavailable' });
  } finally { await f.runtime.dispose(); }
  assert.deepEqual([...f.released].sort(), [sessionId, viewSessionId].sort());
});

test('提供者卸载撤销不返回的调用资格，旧成功不能复活重载后的服务模型', async () => {
  const pending = deferred<Response>();
  let reads = 0, posts = 0;
  const f = await fixture(async (input, init) => {
    const path = requestUrl(input).pathname;
    if (path === '/api/v2/operations' && reads++ === 0) return pending.promise;
    if (path === '/api/v2/operations')
      return success(actions.map((action) => ({ id: `plugin.ai-sdk.${action}`, title: action, input_schema: { type: 'object' } })));
    if (init?.method === 'POST') posts++;
    throw new Error(`卸载前旧成功不得派发后续请求：${path}`);
  });
  try {
    const call = f.call(sdkId, { action: 'runtime.status' });
    const ended = assert.rejects(call, (error: unknown) => error instanceof HostError && error.kind === 'cancelled');
    await until(() => reads === 1);
    await f.runtime.webPlugins.unload(pluginId);
    await ended;
    await f.runtime.webPlugins.load(pluginId);
    const snapshot = (await f.call(streamId, { action: 'snapshot' })).data;
    assert.ok(isRecord(snapshot) && snapshot.session === null);
    pending.resolve(success(actions.map((action) => ({
      id: `plugin.ai-sdk.${action}`, title: action, input_schema: { type: 'object' },
    })), 'late-log'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(posts, 0);
    assert.equal(reads, 1);
  } finally { await f.runtime.dispose(); }
});

test('调用方取消只结束等待，消费者卸载不拆服务模型；提供者随后独立撤销自有Job', async () => {
  const control = { cleanup: false }, contexts: HostContext[] = [];
  let posts = 0, reads = 0, cancelled = 0;
  const f = await fixture(async (input, init) => {
    const path = requestUrl(input).pathname;
    if (path === '/api/v2/operations')
      return success(actions.map((action) => ({ id: `plugin.ai-sdk.${action}`, title: action, input_schema: { type: 'object' } })));
    if (path === '/api/v2/jobs') {
      posts++;
      return success({ id: 'owned', operation: 'plugin.ai-sdk.sdk.single', status: 'running' }, 'accepted-log');
    }
    if (path === '/api/v2/jobs/owned/cancel') {
      cancelled++;
      return success({ id: 'owned', operation: 'plugin.ai-sdk.sdk.single', status: 'cancelled' }, 'cancel-log');
    }
    if (path === '/api/v2/jobs/owned') {
      reads++;
      if (!control.cleanup) return new Promise<never>(() => {});
      return success({ id: 'owned', operation: 'plugin.ai-sdk.sdk.single', status: 'running' }, 'query-log');
    }
    throw new Error(`调用方撤销不能重提交：${path}`);
  });
  f.runtime.bundledPlugins.register({ id: 'ai_consumer', trusted: true, plugin: {
    id: 'ai_consumer', version: '1', apiVersion: 2, panels: [],
    async activate(context) { contexts.push(context); },
  } });
  await f.runtime.webPlugins.load('ai_consumer');
  const extensions = contexts[0]?.extensions;
  assert.ok(extensions);
  try {
    const controller = new AbortController();
    const waiting = extensions.callService(sdkId, '1', request('sdk.single'), controller.signal);
    const ended = assert.rejects(waiting, (error: unknown) => error instanceof HostError && error.kind === 'cancelled');
    await new Promise<void>((resolve) => setTimeout(resolve, 120));
    await until(() => posts === 1 && reads >= 1);
    controller.abort(); await ended;
    assert.equal(cancelled, 0);
    await f.runtime.webPlugins.unload('ai_consumer');
    assert.equal(cancelled, 0);
    assert.ok(f.runtime.host.extensions?.catalog().services.some((entry) => entry.id === sdkId));
    assert.throws(() => extensions.callService(sdkId, '1', request('runtime.status'), signal()),
      { code: 'extension_revoked' });
    control.cleanup = true;
    await f.runtime.webPlugins.unload(pluginId);
    assert.equal(cancelled, 1);
    assert.equal(posts, 1);
  } finally {
    control.cleanup = true;
    await f.runtime.dispose();
  }
});

test('序列化沿UTF8字节数、有限JSON与32MiB输出上限，输出错误保留本次日志', async () => {
  const source = { answer: '字' }, copied = boundedServiceJson(source, 32);
  source.answer = '修改';
  assert.deepEqual(copied, { answer: '字' });
  assert.throws(() => boundedServiceJson('字', 4), { code: 'ai_sdk_service_limit' });
  for (const value of [NaN, Infinity, undefined, { unavailable: undefined }])
    assert.throws(() => boundedServiceJson(value, 32), { code: 'invalid_ai_sdk_service_json' });
  await assert.rejects(serviceResult(Promise.resolve({ data: undefined, logId: 'bad-output-log' })),
    { code: 'invalid_ai_sdk_service_json', logId: 'bad-output-log' });
  await assert.rejects(serviceResult(Promise.resolve({ data: 'x'.repeat(32 * 1024 * 1024), logId: 'large-output-log' })),
    { code: 'ai_sdk_service_limit', logId: 'large-output-log' });
});
