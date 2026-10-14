import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiSdk, createHttpAiSdk } from '../src/features/ai-sdk/index.ts';
import type { AiSdkAction } from '../src/features/ai-sdk/index.ts';
import { ApiError, createApiClient } from '../src/services/api/index.ts';
import type { OperationDto } from '../src/services/api/index.ts';
import { JobWaitFailure } from '../src/shared/jobs/index.ts';
import type { JobGateway, JobTicket, JsonData, TaskRecord } from '../src/shared/jobs/index.ts';
import { normalizeAiSdkAssistant, normalizeAiSdkThread, normalizeAiSdkTurn } from '../src/features/ai-sdk/utils/rules.ts';
import { decodeAiSdkAssistant, decodeAiSdkStatus, decodeAiSdkThread, decodeAiSdkTurn } from '../src/features/ai-sdk/utils/results.ts';
import { deferred, requestUrl, signal, success } from './fixtures.ts';

const actions: readonly AiSdkAction[] = ['runtime.status', 'sdk.single', 'sdk.turn', 'session.get', 'session.close', 'assistant.run'];
const operation = (action: AiSdkAction) => `plugin.ai-sdk.${action}`;
const threadId = 'abcdef12-1234-1234-1234-123456789abc';
const single = { project_id: 'demo', prompt: '生成设备测试用例' };
const turn = { ...single, thread_id: threadId.toUpperCase() };
const thread = { project_id: single.project_id, thread_id: threadId.toUpperCase() };
const assistant = { project_id: single.project_id, user_prompt: '继续测试', stream_output: false };
function definitions(): OperationDto[] { return actions.map((action) => ({ id: operation(action), title: action, input_schema: { type: 'object' } })); }
function turnResult(changes: Record<string, unknown> = {}) {
  return { provider: 'codex_sdk', sdk_version: '0.162.1', project_id: 'demo', thread_id: threadId, text: '最终回答', turns: '1', resource_scope: 'sdk_worker_proxy_and_cli', ...changes };
}
function runtime(changes: Record<string, unknown> = {}) {
  return { provider: 'codex_sdk', sdk_version: '0.162.1', profile: 'codex_sdk_ts_0_162_1_node24', configured: true,
    node_version: '24.14.0', cli_version: '0.162.1', sdk_loaded: true, process_scope_qualified: true, model_verified: false, ready: true,
    projects: ['demo'], reason: null, resource_scope: 'sdk_worker_proxy_and_cli', ...changes };
}
function session(changes: Record<string, unknown> = {}) {
  return { provider: 'codex_sdk', sdk_version: '0.162.1', profile: 'codex_sdk_ts_0_162_1_node24', project_id: 'demo', thread_id: threadId,
    turns: '0', closed: false, uncertain: true, resource_scope: 'sdk_worker_proxy_and_cli', ...changes };
}
function result(action: AiSdkAction): unknown {
  switch (action) {
    case 'runtime.status': return runtime();
    case 'sdk.single': return turnResult();
    case 'sdk.turn': return turnResult({ turns: '3' });
    case 'session.get': return session();
    case 'session.close': return session({ closed: true });
    case 'assistant.run': return turnResult({ turns: '4', assistant_turns: '4', stream_output: false });
  }
}
function envelope(action: AiSdkAction, value = result(action)) { return { result: value, artifacts: [] }; }
function input(action: AiSdkAction): JsonData {
  switch (action) {
    case 'runtime.status': return {};
    case 'sdk.single': return single;
    case 'sdk.turn': return { ...turn, thread_id: threadId };
    case 'session.get': case 'session.close': return { ...thread, thread_id: threadId };
    case 'assistant.run': return assistant;
  }
}
function gateway(action: AiSdkAction = 'sdk.single', changes: Partial<JobGateway> = {}): JobGateway {
  return {
    submit: async (id) => ({ data: { id: 'sdk-job', operation: id, status: 'succeeded', result: envelope(action) }, logId: 'submit-log' }),
    getJob: async () => ({ data: { id: 'sdk-job', operation: operation(action), status: 'succeeded', result: envelope(action) }, logId: 'query-log' }),
    cancelJob: async () => ({ data: { id: 'sdk-job', operation: operation(action), status: 'cancelled' }, logId: 'cancel-log' }),
    ...changes,
  };
}
type AiSdk = ReturnType<typeof createAiSdk>;
interface Invocation {
  readonly action: AiSdkAction;
  readonly start: (sdk: AiSdk, signal: AbortSignal) => Promise<{ readonly submitLogId: string | null; readonly logId: string | null }>;
  readonly resume: (sdk: AiSdk, ticket: JobTicket, signal: AbortSignal) => Promise<{ readonly submitLogId: string | null; readonly logId: string | null }>;
}
const invocations: readonly Invocation[] = [
  { action: 'runtime.status', start: (sdk, signal) => sdk.runtimeStatus(signal), resume: (sdk, ticket, signal) => sdk.resumeStatus(ticket, signal) },
  { action: 'sdk.single', start: (sdk, signal) => sdk.single(single, signal), resume: (sdk, ticket, signal) => sdk.resumeSingle(ticket, single, signal) },
  { action: 'sdk.turn', start: (sdk, signal) => sdk.turn(turn, signal), resume: (sdk, ticket, signal) => sdk.resumeTurn(ticket, turn, signal) },
  { action: 'session.get', start: (sdk, signal) => sdk.getThread(thread, signal), resume: (sdk, ticket, signal) => sdk.resumeGetThread(ticket, thread, signal) },
  { action: 'session.close', start: (sdk, signal) => sdk.closeThread(thread, signal), resume: (sdk, ticket, signal) => sdk.resumeCloseThread(ticket, thread, signal) },
  { action: 'assistant.run', start: (sdk, signal) => sdk.runAssistant(assistant, signal), resume: (sdk, ticket, signal) => sdk.resumeAssistant(ticket, assistant, signal) },
];

test('真实HTTP客户端消费六项普通贡献，规范线程UUID并保留提供者、轮次与日志', async () => {
  const calls: { path: string; body: unknown }[] = [];
  const client = createApiClient({ baseUrl: 'http://localhost:3000', transport: async (request, init) => {
    const url = requestUrl(request); const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ path: url.pathname, body });
    if (url.pathname.endsWith('/operations')) return success([...definitions(), { id: 'plugin.ai-sdk.sdk.stream', title: '实时贡献', input_schema: { type: 'object' } }], 'catalog-log');
    if (typeof body === 'object' && body !== null && 'operation' in body && typeof body.operation === 'string') {
      const action = actions.find((action) => operation(action) === body.operation);
      if (action) return success({ id: 'sdk-job', operation: body.operation, input: 'input' in body ? body.input : {}, created_at: 1, status: 'succeeded', result: envelope(action) }, 'task-log');
    }
    throw new Error('未声明HTTP请求');
  } });
  const sdk = createHttpAiSdk(client, { pollIntervalMs: 0 });
  for (const invocation of invocations) assert.throws(() => invocation.start(sdk, signal()), ApiError);
  await sdk.refreshOperations(signal());
  const outcomes = [];
  for (const invocation of invocations) outcomes.push(await invocation.start(sdk, signal()));
  assert.deepEqual(calls.slice(1).map((call) => call.body), actions.map((action) => ({ operation: operation(action), input: input(action) })));
  assert.ok(outcomes.every((outcome) => outcome.submitLogId === 'task-log' && outcome.logId === 'task-log'));
  assert.equal(sdk.snapshot().operations.length, 6); assert.equal(sdk.snapshot().logId, 'catalog-log');
  assert.equal(thread.thread_id, threadId.toUpperCase()); sdk.dispose();
});

test('项目、提示词与未知字段沿冻结输入合同，Unicode按Rust字符数和空白判定', () => {
  for (const project_id of ['demo', '-_', 'a'.repeat(80)]) normalizeAiSdkTurn({ ...single, project_id }, false);
  for (const project_id of ['', '项目', 'a'.repeat(81), 'demo/path', 'demo:1']) assert.throws(() => normalizeAiSdkTurn({ ...single, project_id }, false), ApiError);
  normalizeAiSdkTurn({ ...single, prompt: '😀'.repeat(131072) }, false);
  normalizeAiSdkTurn({ ...single, prompt: '\ufeff' }, false);
  normalizeAiSdkTurn({ ...single, prompt: '\0' }, false);
  for (const prompt of ['', ' \t\n', '\u0085', '😀'.repeat(131073), '\ud800', '\udc00']) assert.throws(() => normalizeAiSdkTurn({ ...single, prompt }, false), ApiError);
  for (const value of [
    { ...single, thread_id: threadId }, { ...single, thread_id: null }, { ...single, path: 'C:/other' },
    { ...single, model: 'browser-choice' }, { ...single, provider: 'codex_cli' }, { ...single, environment: {} }, { ...single, prompt: undefined },
  ]) assert.throws(() => normalizeAiSdkTurn(value, false), ApiError);
  for (const thread_id of [null, '', 'not-a-uuid', threadId + '-extra', threadId.replace('-', '_')]) assert.throws(() => normalizeAiSdkTurn({ ...single, thread_id }, true), ApiError);
  assert.equal(normalizeAiSdkTurn(turn, true).thread_id, threadId); assert.equal(normalizeAiSdkThread(thread).thread_id, threadId);
  assert.deepEqual(normalizeAiSdkAssistant({ project_id: 'demo' }), { project_id: 'demo' });
  for (const value of [
    { project_id: 'demo', user_prompt: null }, { project_id: 'demo', user_prompt: '\u0085' }, { project_id: 'demo', stream_output: null },
    { project_id: 'demo', stream_output: 'true' }, { project_id: 'demo', thread_id: threadId }, { project_id: 'demo', tool: 'unknown' },
  ]) assert.throws(() => normalizeAiSdkAssistant(value), ApiError);
});

test('新线程仅一轮，恢复线程精确归属且u64轮次保持十进制字符串', () => {
  const expected = normalizeAiSdkTurn(single, false);
  for (const changes of [
    { provider: 'codex_cli' }, { sdk_version: '0.57.0' }, { project_id: 'other' }, { thread_id: threadId.toUpperCase() },
    { text: '' }, { text: '\u0085' }, { text: '\ud800' }, { text: '文'.repeat(174763) }, { turns: '0' }, { turns: '2' },
    { turns: 1 }, { turns: '01' }, { turns: '18446744073709551616' }, { resource_scope: 'all_descendants_released' }, { project_root: 'C:/private' },
  ]) assert.throws(() => decodeAiSdkTurn(envelope('sdk.single', turnResult(changes)), 'turn-result-log', expected), (error: unknown) => error instanceof ApiError && error.logId === 'turn-result-log');
  const continued = normalizeAiSdkTurn(turn, true);
  const result = decodeAiSdkTurn(envelope('sdk.turn', turnResult({ turns: '18446744073709551615', text: '😀'.repeat(131072) })), null, continued);
  assert.equal(result.turns, '18446744073709551615'); assert.ok(Object.isFrozen(result));
  assert.throws(() => decodeAiSdkTurn(envelope('sdk.turn', turnResult({ thread_id: '12345678-1234-1234-1234-123456789abc' })), null, continued), ApiError);
});

test('资格状态各字段独立观察，不从ready推导模型或资源树退出', () => {
  const ready = decodeAiSdkStatus(envelope('runtime.status'), 'status-log');
  assert.equal(ready.ready, true); assert.equal(ready.model_verified, false); assert.ok(Object.isFrozen(ready.projects));
  const unavailable = decodeAiSdkStatus(envelope('runtime.status', runtime({ node_version: '26.0.0', cli_version: null, sdk_loaded: false, process_scope_qualified: false, ready: false, reason: '运行时版本未取得资格' })), null);
  assert.equal(unavailable.node_version, '26.0.0'); assert.equal(unavailable.ready, false);
  for (const changes of [
    { profile: 'other-profile' }, { provider: 'codex_cli' }, { ready: 'true' }, { projects: ['demo', 'demo'] }, { projects: ['bad/path'] },
    { projects: Array.from({ length: 65 }, (_value, index) => `p${index}`) }, { node_version: 24 }, { reason: '\ud800' }, { environment: {} },
  ]) assert.throws(() => decodeAiSdkStatus(envelope('runtime.status', runtime(changes)), 'bad-status-log'), (error: unknown) => error instanceof ApiError && error.logId === 'bad-status-log');
});

test('查询保留closed与uncertain，关闭只确认本地资格而不补造历史删除', () => {
  const expected = normalizeAiSdkThread(thread);
  const observed = decodeAiSdkThread(envelope('session.get'), null, expected, false);
  assert.equal(observed.turns, '0'); assert.equal(observed.uncertain, true); assert.equal(observed.closed, false);
  const closed = decodeAiSdkThread(envelope('session.close'), null, expected, true);
  assert.equal(closed.closed, true); assert.equal(closed.uncertain, true);
  for (const changes of [
    { project_id: 'other' }, { thread_id: threadId.toUpperCase() }, { turns: 0 }, { turns: '-1' }, { uncertain: null }, { closed: 'false' },
    { profile: 'cli' }, { project_root: 'C:/private' }, { history_deleted: true },
  ]) assert.throws(() => decodeAiSdkThread(envelope('session.get', session(changes)), 'session-log', expected, false), (error: unknown) => error instanceof ApiError && error.logId === 'session-log');
  assert.throws(() => decodeAiSdkThread(envelope('session.close', session({ closed: false })), null, expected, true), ApiError);
});

test('助手普通任务保留新线程一至四轮和stream选择，不执行前端补轮或回退', () => {
  for (const count of ['1', '2', '3', '4']) {
    const decoded = decodeAiSdkAssistant(envelope('assistant.run', turnResult({ turns: count, assistant_turns: count, stream_output: false })), null, assistant);
    assert.equal(decoded.assistant_turns, count); assert.ok(Object.isFrozen(decoded));
  }
  assert.equal(decodeAiSdkAssistant(envelope('assistant.run', turnResult({ assistant_turns: '1', stream_output: true })), null, { project_id: 'demo', stream_output: true }).turns, '1');
  for (const changes of [
    { assistant_turns: '5', turns: '5' }, { assistant_turns: '0', turns: '0' }, { assistant_turns: '2', turns: '1' },
    { assistant_turns: 1 }, { stream_output: true }, { schema: { is_final: true } },
  ]) assert.throws(() => decodeAiSdkAssistant(envelope('assistant.run', { ...turnResult({ assistant_turns: '1', stream_output: false }), ...changes }), 'assistant-log', assistant), (error: unknown) => error instanceof ApiError && error.logId === 'assistant-log');
  assert.throws(() => decodeAiSdkAssistant(envelope('assistant.run', turnResult({ turns: '2', assistant_turns: '2', stream_output: true })), null, { project_id: 'demo', stream_output: true }), ApiError);
});

test('六项普通任务取消等待后恢复原Job，目录失效不重提或自动关闭线程', async () => {
  for (const invocation of invocations) {
    let submissions = 0; let cancels = 0; let failed = false;
    const sdk = createAiSdk(gateway(invocation.action, {
      submit: async (id) => { submissions++; return { data: { id: 'sdk-job', operation: id, status: 'running' }, logId: 'submit-log' }; },
      cancelJob: async () => { cancels++; return { data: { id: 'sdk-job', operation: operation(invocation.action), status: 'cancelled' }, logId: 'explicit-cancel-log' }; },
    }), { pollIntervalMs: 10000, operations: { list: async () => {
      if (failed) throw new ApiError('http', 'plugin_unavailable', 'SDK贡献暂不可用', 503, 'catalog-error-log');
      return { data: definitions(), logId: 'catalog-log' };
    } } });
    await sdk.refreshOperations(signal());
    const controller = new AbortController(); const waiting = invocation.start(sdk, controller.signal);
    await new Promise((resolve) => setImmediate(resolve)); controller.abort();
    await assert.rejects(waiting, (error: unknown) => error instanceof JobWaitFailure && error.job.id === 'sdk-job'
      && error.job.operation === operation(invocation.action) && error.submitLogId === 'submit-log' && error.lastKnownLogId === 'submit-log');
    failed = true; await assert.rejects(sdk.refreshOperations(signal()), ApiError);
    assert.throws(() => invocation.start(sdk, signal()), ApiError);
    const ticket = { id: 'sdk-job', operation: operation(invocation.action), submitLogId: 'submit-log' };
    assert.equal((await sdk.queryJob(ticket, signal())).logId, 'query-log');
    const resumed = await invocation.resume(sdk, ticket, signal());
    assert.equal(resumed.submitLogId, 'submit-log'); assert.equal(resumed.logId, 'query-log'); assert.equal(submissions, 1); assert.equal(cancels, 0);
    assert.equal((await sdk.cancel(ticket, signal())).logId, 'explicit-cancel-log'); assert.equal(cancels, 1); sdk.dispose();
  }
});

test('输入与恢复票据建立冻结副本，调用者修改不改变项目和原Job归属', async () => {
  const submitted: JsonData[] = []; const waiting = deferred<{ data: TaskRecord; logId: string }>();
  const sdk = createAiSdk(gateway('sdk.single', { submit: async (_operation, value) => { submitted.push(value); return waiting.promise; } }),
    { operations: { list: async () => ({ data: definitions(), logId: 'catalog-log' }) } });
  await sdk.refreshOperations(signal());
  const original = { ...single }; const pending = sdk.single(original, signal());
  original.project_id = 'other'; original.prompt = '替换提示词';
  assert.deepEqual(submitted, [single]); assert.ok(Object.isFrozen(submitted[0]));
  waiting.resolve({ data: { id: 'sdk-job', operation: operation('sdk.single'), status: 'succeeded', result: envelope('sdk.single') }, logId: 'copy-log' });
  assert.equal((await pending).data.project_id, 'demo'); sdk.dispose();
  const query = deferred<{ data: TaskRecord; logId: string }>(); const seen: string[] = [];
  const resumedSdk = createAiSdk(gateway('sdk.turn', { getJob: async (id) => { seen.push(id); return query.promise; } }));
  const ticket = { id: 'sdk-job', operation: operation('sdk.turn'), submitLogId: 'original-submit-log' }; const originalTurn = { ...turn };
  const restored = resumedSdk.resumeTurn(ticket, originalTurn, signal());
  ticket.id = 'other-job'; ticket.operation = operation('session.close'); ticket.submitLogId = 'fake-log'; originalTurn.project_id = 'other'; originalTurn.thread_id = '12345678-1234-1234-1234-123456789abc';
  query.resolve({ data: { id: 'sdk-job', operation: operation('sdk.turn'), status: 'succeeded', result: envelope('sdk.turn') }, logId: 'query-log' });
  const completed = await restored;
  assert.deepEqual(seen, ['sdk-job']); assert.equal(completed.submitLogId, 'original-submit-log'); assert.equal(completed.data.thread_id, threadId); resumedSdk.dispose();
});

test('票据拒绝CLI、协议5会话、错操作与自由字段，响应身份错误保留日志', async () => {
  const sdk = createAiSdk(gateway()); const ticket = { id: 'sdk-job', operation: operation('sdk.single'), submitLogId: 'submit-log' };
  for (const id of ['plugin.ai-assistant.sdk.single', 'plugin.ai-sdk.sdk.stream', 'plugin.other.run']) {
    assert.throws(() => sdk.queryJob({ ...ticket, operation: id }, signal()), ApiError);
    assert.throws(() => sdk.cancel({ ...ticket, operation: id }, signal()), ApiError);
  }
  const extraTicket = { ...ticket, path: 'C:/private' };
  assert.throws(() => sdk.queryJob(extraTicket, signal()), ApiError);
  assert.throws(() => sdk.queryJob({ ...ticket, id: '' }, signal()), ApiError);
  for (const invocation of invocations) {
    const other = invocation.action === 'sdk.single' ? 'sdk.turn' : 'sdk.single';
    assert.throws(() => invocation.resume(sdk, { ...ticket, operation: operation(other) }, signal()), ApiError);
  }
  sdk.dispose();
  const wrong = createAiSdk(gateway('sdk.single', {
    getJob: async () => ({ data: { id: 'other-job', operation: operation('sdk.single'), status: 'succeeded', result: envelope('sdk.single') }, logId: 'wrong-query-log' }),
    cancelJob: async () => ({ data: { id: 'sdk-job', operation: operation('sdk.turn'), status: 'cancelled' }, logId: 'wrong-cancel-log' }),
  }));
  await assert.rejects(wrong.queryJob(ticket, signal()), (error: unknown) => error instanceof ApiError && error.logId === 'wrong-query-log');
  await assert.rejects(wrong.resumeSingle(ticket, single, signal()), (error: unknown) => error instanceof ApiError && error.logId === 'wrong-query-log');
  await assert.rejects(wrong.cancel(ticket, signal()), (error: unknown) => error instanceof ApiError && error.logId === 'wrong-cancel-log'); wrong.dispose();
});

test('目录刷新撤销入口，替换、取消及销毁不接受旧成功或旧拒绝', async () => {
  for (const rejects of [false, true]) {
    const delayed = deferred<{ data: unknown; logId: string }>(); let calls = 0;
    const sdk = createAiSdk(gateway(), { operations: { list: async () => ++calls === 1 ? delayed.promise : { data: [], logId: 'current-log' } } });
    const old = sdk.refreshOperations(signal()); const rejected = assert.rejects(old, ApiError);
    await sdk.refreshOperations(signal()); await rejected;
    if (rejects) delayed.reject(new Error('晚到目录失败')); else delayed.resolve({ data: definitions(), logId: 'old-log' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sdk.snapshot().logId, 'current-log'); assert.equal(sdk.snapshot().error, null); assert.equal(sdk.snapshot().operations.length, 0); sdk.dispose();
  }
  for (const closed of [false, true]) {
    const delayed = deferred<{ data: unknown; logId: string }>(); let calls = 0;
    const sdk = createAiSdk(gateway(), { operations: { list: async () => ++calls === 1 ? { data: definitions(), logId: 'first-log' } : delayed.promise } });
    await sdk.refreshOperations(signal()); const controller = new AbortController(); const waiting = sdk.refreshOperations(controller.signal);
    assert.equal(sdk.snapshot().operations.length, 0); assert.equal(sdk.snapshot().refreshing, true); assert.throws(() => sdk.single(single, signal()), ApiError);
    if (closed) sdk.dispose(); else controller.abort(); await assert.rejects(waiting, ApiError);
    delayed.reject(new Error('撤销后目录拒绝')); await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sdk.snapshot().operations.length, 0); assert.equal(sdk.snapshot().refreshing, false); sdk.dispose();
  }
  for (const data of [[...definitions(), definitions()[0]], [{ id: operation('sdk.single'), title: '错误模式', input_schema: { type: 'array' } }], null]) {
    const sdk = createAiSdk(gateway(), { operations: { list: async () => ({ data, logId: 'invalid-catalog-log' }) } });
    await assert.rejects(sdk.refreshOperations(signal()), (error: unknown) => error instanceof ApiError && error.logId === 'invalid-catalog-log'); sdk.dispose();
  }
  const sdk = createAiSdk(gateway());
  assert.throws(() => sdk.refreshOperations(signal()), (error: unknown) => error instanceof ApiError && error.code === 'ai_sdk_catalog_not_configured');
  assert.throws(() => sdk.single(single, signal()), ApiError);
  assert.equal((await sdk.resumeSingle({ id: 'sdk-job', operation: operation('sdk.single'), submitLogId: 'submit-log' }, single, signal())).logId, 'query-log'); sdk.dispose();
});

test('普通成功结果必须空产物封套，销毁消费晚拒绝且不自动cancel或close', async () => {
  const artifact = { id: 'unexpected', filename: 'unexpected.json', media_type: 'application/json', size: 0, sha256: 'a'.repeat(64), created_at: 1 };
  for (const invocation of invocations) {
    const sdk = createAiSdk(gateway(invocation.action, { getJob: async () => ({ data: { id: 'sdk-job', operation: operation(invocation.action), status: 'succeeded', result: { result: result(invocation.action), artifacts: [artifact] } }, logId: 'unexpected-artifact-log' }) }));
    await assert.rejects(invocation.resume(sdk, { id: 'sdk-job', operation: operation(invocation.action), submitLogId: 'submit-log' }, signal()), (error: unknown) => error instanceof ApiError && error.logId === 'unexpected-artifact-log'); sdk.dispose();
  }
  for (const rejects of [false, true]) {
    const delayed = deferred<{ data: TaskRecord; logId: string }>(); const started = deferred<void>(); let submissions = 0; let cancels = 0;
    const sdk = createAiSdk(gateway('sdk.single', {
      submit: async (id) => { submissions++; return { data: { id: 'sdk-job', operation: id, status: 'running' }, logId: 'running-log' }; },
      getJob: async () => { started.resolve(); return delayed.promise; },
      cancelJob: async () => { cancels++; throw new Error('不能自动取消服务器'); },
    }), { pollIntervalMs: 0, operations: { list: async () => ({ data: definitions(), logId: 'catalog-log' }) } });
    await sdk.refreshOperations(signal()); const waiting = sdk.single(single, signal()); await started.promise; sdk.dispose();
    await assert.rejects(waiting, (error: unknown) => error instanceof JobWaitFailure && error.submitLogId === 'running-log' && error.lastKnownLogId === 'running-log');
    if (rejects) delayed.reject(new Error('晚到SDK任务失败'));
    else delayed.resolve({ data: { id: 'sdk-job', operation: operation('sdk.single'), status: 'succeeded', result: envelope('sdk.single') }, logId: 'late-log' });
    await new Promise((resolve) => setImmediate(resolve)); assert.equal(submissions, 1); assert.equal(cancels, 0); assert.equal(sdk.snapshot().operations.length, 0);
  }
});
