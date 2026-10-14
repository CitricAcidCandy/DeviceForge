import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiStreaming, createHttpAiStreaming } from '../src/features/ai-streaming/index.ts';
import { AiStreamDecoder } from '../src/features/ai-streaming/services/decoder.ts';
import { ApiError, createApiClient } from '../src/services/api/index.ts';
import type { ApiResult, SessionDefinitions, SessionGateway, SessionInfo, SessionOutputPage } from '../src/services/api/index.ts';
import { deferred, requestUrl, signal, success } from './fixtures.ts';

const sessionId = '12345678-1234-1234-1234-123456789abc';
const threadId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const operation = 'plugin.ai-assistant.cli.stream';
function info(changes: Partial<SessionInfo> = {}): SessionInfo {
  return { id: sessionId, operation, plugin_id: 'ai-assistant', generation: 'generation-1', created_at: 1, status: 'running', output_sequence: 0, completion: null, ...changes };
}
function result(text = '你好🙂') {
  return { project_id: 'demo', thread_id: threadId, text, turns: '1', stream_format_version: 1, provider: 'codex_cli', resource_scope: 'direct_process' };
}
function finished(outputSequence = 0, changes: Partial<SessionInfo> = {}): SessionInfo {
  return info({ status: 'finished', output_sequence: outputSequence, completion: { outcome: { result: result(), artifacts: [], error: null }, cleanup: 'complete', process_exited: true, sequence: 8, failure: null }, ...changes });
}
function events(text = '你好🙂'): unknown[] {
  return [
    { format_version: 1, type: 'thread.started', thread_id: threadId },
    { format_version: 1, type: 'turn.started' },
    { format_version: 1, type: 'item.started', item: { id: 'item_1', type: 'agent_message', text: '你' } },
    { format_version: 1, type: 'item.updated', item: { id: 'item_1', type: 'agent_message', text } },
    { format_version: 1, type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text } },
    { format_version: 1, type: 'turn.completed' },
  ];
}
function chunks(values: unknown[] = events(), size = 81): SessionOutputPage['chunks'] {
  const bytes = new TextEncoder().encode(values.map((value) => JSON.stringify(value)).join('\r\n') + '\r\n');
  const output: SessionOutputPage['chunks'] = [];
  for (let offset = 0; offset < bytes.length; offset += size) output.push({ sequence: output.length + 1, stream: 'stdout', bytes: Array.from(bytes.subarray(offset, offset + size)) });
  return output;
}
function definitions(): SessionDefinitions {
  return { revision: 1, sessions: [{ id: operation, title: 'AI 实时输出', input_schema: { type: 'object' }, execution: { api_version: 1, source: 'declared', total_timeout_ms: 600000 } }] };
}
function gateway(changes: Partial<SessionGateway> = {}): SessionGateway {
  return {
    definitions: async () => ({ data: definitions(), logId: 'definitions-log' }),
    list: async () => ({ data: [info()], logId: 'records-log' }),
    open: async () => ({ data: info({ status: 'opening' }), logId: 'open-log' }),
    get: async (id) => ({ data: info({ id }), logId: 'query-log' }),
    output: async () => ({ data: { session: info(), chunks: [], next_sequence: 0 }, logId: 'output-log' }),
    send: async (id) => ({ data: { id, accepted: true }, logId: 'input-log' }),
    eof: async (id) => ({ data: { id, accepted: true }, logId: 'eof-log' }),
    cancel: async (id) => ({ data: info({ id, status: 'stopping' }), logId: 'cancel-log' }),
    remove: async (id) => ({ data: { id }, logId: 'remove-log' }),
    ...changes,
  };
}

test('逐字节UTF-8和CRLF解析保留实际输出序号，updated替换正文快照', () => {
  const source = chunks(events(), 1);
  const decoder = new AiStreamDecoder(null);
  for (const chunk of source) decoder.append(chunk, 'stream-log');
  const view = decoder.snapshot();
  assert.equal(view.cursor, source.length);
  assert.equal(view.events.length, 6);
  assert.equal(view.text, '你好🙂');
  assert.equal(view.items[0]?.item.text, '你好🙂');
  assert.equal(view.providerCompleted, true);
  assert.equal(view.threadId, threadId);
  assert.equal(view.events[0]?.firstSequence, 1);
  assert.ok((view.events[0]?.sequence ?? 0) > 1);
  assert.deepEqual(view.chunks, source);
  assert.ok(Object.isFrozen(view.chunks[0]?.bytes));
  assert.deepEqual(decoder.complete(result(), 'demo', 'completion-log'), result());
});

test('拒绝非法UTF-8、非白名单/额外字段、错线程及跳号，不把敏感值写进错误', () => {
  const values: unknown[][] = [
    [{ format_version: 1, type: 'thread.started', thread_id: sessionId }],
    [{ format_version: 1, type: 'error', details: 'SECRET-DIAGNOSTIC' }],
    [{ format_version: 1, type: 'thread.started', thread_id: threadId, credential: 'SECRET-DIAGNOSTIC' }],
    [{ format_version: 1, type: 'thread.started', thread_id: threadId }, { format_version: 1, type: 'turn.started' }, { format_version: 1, type: 'item.completed', item: { id: 'item_1', type: 'command_execution', text: 'SECRET-DIAGNOSTIC' } }],
  ];
  for (const source of values) {
    const decoder = new AiStreamDecoder(threadId);
    assert.throws(() => { for (const chunk of chunks(source)) decoder.append(chunk, 'invalid-log'); }, (error: unknown) => error instanceof ApiError && error.logId === 'invalid-log' && !error.message.includes('SECRET-DIAGNOSTIC'));
  }
  const invalid = new AiStreamDecoder(null);
  assert.throws(() => invalid.append({ sequence: 1, stream: 'stdout', bytes: [0xc0, 0xaf, 10] }, 'utf8-log'), ApiError);
  assert.throws(() => new AiStreamDecoder(null).append({ sequence: 2, stream: 'stdout', bytes: [] }, 'gap-log'), ApiError);
  assert.throws(() => new AiStreamDecoder(null).append({ sequence: 1, stream: 'stderr', bytes: [10] }, 'stderr-log'), ApiError);
});

test('Finished成功必须完整事件、空残行及精确项目线程正文，turn.completed不替代终态', () => {
  const decoder = new AiStreamDecoder(null);
  for (const chunk of chunks()) decoder.append(chunk, null);
  for (const data of [result('别的正文'), { ...result(), project_id: 'other' }, { ...result(), thread_id: sessionId }, { ...result(), turns: 1 }, { ...result(), turns: '0' }, { ...result(), events: [] }]) assert.throws(() => decoder.complete(data, 'demo', 'finished-log'), ApiError);
  decoder.append({ sequence: decoder.snapshot().cursor + 1, stream: 'stdout', bytes: [0xe4] }, null);
  assert.throws(() => decoder.complete(result(), 'demo', null), ApiError);
});

test('真实HTTP端点动态发现并提交一次Open，逐页耗尽Finished后才发布结果', async () => {
  const source = chunks();
  const requests: { path: string; method: string; body: unknown }[] = [];
  const client = createApiClient({ baseUrl: 'http://localhost:3000', transport: async (input, init) => {
    const url = requestUrl(input);
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    requests.push({ path: url.pathname + url.search, method: init?.method ?? 'GET', body });
    if (url.pathname.endsWith('/session-definitions')) return success(definitions(), 'definitions-log');
    if (url.pathname === '/api/v2/sessions') return success(info({ status: 'opening' }), 'open-log', 202);
    if (url.pathname.endsWith('/output')) {
      const after = Number(url.searchParams.get('after'));
      const limit = Number(url.searchParams.get('limit'));
      const pageChunks = source.slice(after, after + limit);
      return success({ session: finished(source.length), chunks: pageChunks, next_sequence: after + pageChunks.length }, 'output-log');
    }
    throw new Error('没有授权的HTTP调用');
  } });
  const streaming = createHttpAiStreaming(client, { pollIntervalMs: 0 });
  assert.throws(() => streaming.open({ project_id: 'demo', prompt: '你好' }, signal()), ApiError);
  await streaming.refreshDefinitions(signal());
  await streaming.open({ project_id: 'demo', prompt: '你好' }, signal());
  await streaming.readOutput({ limit: 1 }, signal());
  assert.equal(streaming.snapshot().result, null);
  await streaming.pollOutput({ limit: 2 }, signal());
  assert.deepEqual(streaming.snapshot().result, result());
  assert.equal(streaming.snapshot().session?.id, sessionId);
  assert.equal(streaming.snapshot().stream.threadId, threadId);
  assert.equal(requests.filter((request) => request.method === 'POST').length, 1);
  assert.deepEqual(requests[1]?.body, { operation, input: { project_id: 'demo', prompt: '你好' } });
  assert.equal(streaming.snapshot().logs.open, 'open-log');
  assert.equal(streaming.snapshot().logs.output, 'output-log');
  streaming.dispose();
});

test('恢复允许已知线程省略thread.started，条目别名、类型和完成顺序固定', () => {
  const resumed = new AiStreamDecoder(threadId);
  for (const chunk of chunks(events().slice(1))) resumed.append(chunk, null);
  assert.equal(resumed.snapshot().events[0]?.event.type, 'turn.started');
  assert.deepEqual(resumed.complete(result(), 'demo', null), result());
  const bad: unknown[][] = [
    [events()[0], events()[1], { format_version: 1, type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'ok' } }],
    [events()[0], events()[1], events()[2], { format_version: 1, type: 'item.completed', item: { id: 'item_1', type: 'reasoning', text: 'ok' } }],
    [events()[0], events()[1], events()[2], { format_version: 1, type: 'turn.completed' }],
    [...events(), { format_version: 1, type: 'turn.completed' }],
    [events()[0], events()[1], events()[4], events()[4]],
  ];
  for (const value of bad) assert.throws(() => { const decoder = new AiStreamDecoder(null); for (const chunk of chunks(value)) decoder.append(chunk, null); }, ApiError);
});

test('输入沿Rust字符与空白规则，拒绝null线程、额外字段和孤立代理码元', async () => {
  let opens = 0;
  const streaming = createAiStreaming(gateway({ open: async () => { opens++; return { data: info({ status: 'opening' }), logId: 'open-log' }; } }));
  await streaming.refreshDefinitions(signal());
  const values: unknown[] = [
    { project_id: '../demo', prompt: 'ok' }, { project_id: 'demo', prompt: '\u0085' },
    { project_id: 'demo', prompt: '\ud800' }, { project_id: 'demo', prompt: '🙂'.repeat(131073) },
    { project_id: 'demo', prompt: 'ok', thread_id: null }, { project_id: 'demo', prompt: 'ok', thread_id: undefined },
    { project_id: 'demo', prompt: 'ok', command: '秘密命令' },
  ];
  for (const value of values) {
    if (typeof value === 'object' && value !== null && 'project_id' in value && 'prompt' in value && typeof value.project_id === 'string' && typeof value.prompt === 'string') {
      const projectId = value.project_id; const prompt = value.prompt;
      assert.throws(() => streaming.open({ ...value, project_id: projectId, prompt }, signal()), ApiError);
    }
  }
  await streaming.open({ project_id: 'demo', prompt: '🙂'.repeat(131072), thread_id: threadId.toUpperCase() }, signal());
  await streaming.open({ project_id: 'demo', prompt: '\ufeff' }, signal());
  assert.equal(opens, 2);
  streaming.dispose();
});

test('页面缺口、跨代次和stderr整页拒绝，不局部发布先前合法行', async () => {
  const validChunks = chunks([events()[0]], 8192);
  const badPages: unknown[] = [
    { session: info({ generation: 'generation-2', output_sequence: 1 }), chunks: validChunks, next_sequence: 1 },
    { session: info({ output_sequence: 2 }), chunks: [{ sequence: 2, stream: 'stdout', bytes: [10] }], next_sequence: 2 },
    { session: info({ output_sequence: 1 }), chunks: [], next_sequence: 0 },
    { session: info({ output_sequence: 2 }), chunks: [...validChunks, { sequence: 2, stream: 'stderr', bytes: [10] }], next_sequence: 2 },
    { session: info({ output_sequence: 2 }), chunks: [...validChunks, { sequence: 2, stream: 'stdout', bytes: [255, 10] }], next_sequence: 2 },
    { session: info({ output_sequence: 1 }), chunks: validChunks, next_sequence: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const value of badPages) {
    const streaming = createAiStreaming(gateway({ output: async () => ({ data: value, logId: 'bad-page-log' }) }));
    await streaming.resume(sessionId, { project_id: 'demo' }, signal());
    await assert.rejects(streaming.readOutput({}, signal()), (error: unknown) => error instanceof ApiError && error.logId === 'bad-page-log');
    assert.equal(streaming.snapshot().stream.cursor, 0);
    assert.equal(streaming.snapshot().stream.events.length, 0);
    assert.equal(streaming.snapshot().logs.output, 'bad-page-log');
    streaming.dispose();
  }
});

test('停止观测与Finished失败保留原字节和清理证据，失败残行可清除', async () => {
  const source = chunks([events()[0]], 8192);
  source.push({ sequence: 2, stream: 'stdout', bytes: [0xe4] });
  const completion: SessionInfo['completion'] = { outcome: { result: null, artifacts: [], error: 'AI轮次已取消' }, cleanup: 'unconfirmed', process_exited: false, sequence: 3, failure: null };
  const streaming = createAiStreaming(gateway({ output: async () => ({ data: { session: finished(2, { completion }), chunks: source, next_sequence: 2 }, logId: 'cancelled-output-log' }) }));
  await streaming.resume(sessionId, { project_id: 'demo' }, signal());
  await assert.rejects(streaming.readOutput({}, signal()), (error: unknown) => error instanceof ApiError && error.code === 'ai_stream_failed' && error.logId === 'cancelled-output-log');
  assert.equal(streaming.snapshot().stream.cursor, 2);
  assert.equal(streaming.snapshot().stream.pendingBytes, 0);
  assert.deepEqual(streaming.snapshot().stream.chunks, source);
  assert.deepEqual(streaming.snapshot().session?.completion, completion);
  assert.equal(streaming.snapshot().result, null);
  streaming.dispose();
});

test('等待取消后恢复同会话继续游标，不重开、不重放提示词、不自动cancel', async () => {
  const source = chunks();
  const queries: number[] = [];
  let opens = 0; let inputs = 0; let cancels = 0;
  let hanging = true;
  const delayed = deferred<ApiResult<unknown>>();
  const streaming = createAiStreaming(gateway({
    open: async () => { opens++; return { data: info({ status: 'opening' }), logId: 'open-log' }; },
    get: async () => ({ data: info({ output_sequence: source.length }), logId: 'resume-log' }),
    output: async (_id, query) => {
      const after = query.after ?? 0; const limit = query.limit ?? 50; queries.push(after);
      if (after > 0 && hanging) return delayed.promise;
      const batch = source.slice(after, after + limit);
      return { data: { session: hanging ? info({ output_sequence: source.length }) : finished(source.length), chunks: batch, next_sequence: after + batch.length }, logId: 'stream-log' };
    },
    send: async () => { inputs++; throw new Error('禁止追加Input'); },
    cancel: async () => { cancels++; throw new Error('禁止自动cancel'); },
  }), { pollIntervalMs: 0 });
  await streaming.refreshDefinitions(signal());
  await streaming.open({ project_id: 'demo', prompt: '只发送一次' }, signal());
  await streaming.readOutput({ limit: 1 }, signal());
  const controller = new AbortController();
  const waiting = streaming.readOutput({ limit: 1 }, controller.signal);
  controller.abort();
  await assert.rejects(waiting, (error: unknown) => error instanceof ApiError && error.kind === 'cancelled' && error.logId === 'stream-log');
  assert.equal(streaming.snapshot().stream.cursor, 1);
  hanging = false;
  await streaming.resume(sessionId, { project_id: 'demo' }, signal());
  await streaming.pollOutput({ limit: 2 }, signal());
  delayed.resolve({ data: { session: info({ output_sequence: 1 }), chunks: [], next_sequence: 1 }, logId: 'late-log' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(streaming.snapshot().result, result());
  assert.equal(streaming.snapshot().stream.events.length, 6);
  assert.equal(queries[2], 1);
  assert.equal(opens, 1); assert.equal(inputs, 0); assert.equal(cancels, 0);
  streaming.dispose();
});

test('dispose撤销忽略信号的等待，晚到成功与失败均不发布', async () => {
  for (const rejection of [false, true]) {
    const delayed = deferred<ApiResult<unknown>>();
    const streaming = createAiStreaming(gateway({ output: async () => delayed.promise }));
    await streaming.resume(sessionId, { project_id: 'demo' }, signal());
    let notifications = 0;
    streaming.subscribe(() => { notifications++; });
    const waiting = streaming.readOutput({}, signal());
    streaming.dispose();
    await assert.rejects(waiting, (error: unknown) => error instanceof ApiError && error.kind === 'cancelled');
    const before = notifications;
    if (rejection) delayed.reject(new Error('延迟失败')); else delayed.resolve({ data: { session: info(), chunks: [], next_sequence: 0 }, logId: 'late-log' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(notifications, before);
    assert.equal(streaming.snapshot().stream.cursor, 0);
    assert.equal(streaming.snapshot().pending.length, 0);
  }
});

test('并发显式cancel保持Stopping，晚到Running输出不回退且完成后禁止终态漂移', async () => {
  const source = chunks();
  const delayed = deferred<ApiResult<unknown>>();
  let waiting = true; let drift = false;
  const streaming = createAiStreaming(gateway({
    output: async (_id, query) => waiting ? delayed.promise : { data: { session: finished(source.length), chunks: source.slice(query.after ?? 0), next_sequence: source.length }, logId: 'final-log' },
    get: async () => ({ data: drift ? finished(source.length, { completion: { outcome: { result: result('篡改'), artifacts: [], error: null }, cleanup: 'complete', process_exited: true, failure: null, sequence: 8 } }) : info({ output_sequence: source.length }), logId: 'query-log' }),
  }));
  await streaming.resume(sessionId, { project_id: 'demo' }, signal());
  const output = streaming.readOutput({}, signal());
  await streaming.cancel(signal());
  delayed.resolve({ data: { session: info({ output_sequence: source.length }), chunks: source, next_sequence: source.length }, logId: 'running-late-log' });
  await output;
  assert.equal(streaming.snapshot().session?.status, 'stopping');
  assert.equal(streaming.snapshot().result, null);
  waiting = false;
  await streaming.readOutput({}, signal());
  assert.deepEqual(streaming.snapshot().result, result());
  drift = true;
  await assert.rejects(streaming.query(signal()), ApiError);
  assert.deepEqual(streaming.snapshot().result, result());
  streaming.dispose();
});

test('切换后旧输出失效，恢复相同ID不能改变项目或已观测线程归属', async () => {
  const source = chunks([events()[0]], 8192);
  const delayed = deferred<ApiResult<unknown>>();
  const otherId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  let delaying = false;
  const streaming = createAiStreaming(gateway({ output: async () => delaying ? delayed.promise : { data: { session: info({ output_sequence: 1 }), chunks: source, next_sequence: 1 }, logId: 'first-log' } }));
  await streaming.resume(sessionId, { project_id: 'demo' }, signal());
  await streaming.readOutput({}, signal());
  assert.throws(() => streaming.resume(sessionId, { project_id: 'other' }, signal()), ApiError);
  assert.throws(() => streaming.resume(sessionId, { project_id: 'demo', thread_id: sessionId }, signal()), ApiError);
  delaying = true;
  const output = streaming.readOutput({}, signal());
  await streaming.resume(otherId, { project_id: 'demo' }, signal());
  await assert.rejects(output, (error: unknown) => error instanceof ApiError && error.kind === 'cancelled');
  delayed.resolve({ data: { session: info({ output_sequence: 1 }), chunks: [], next_sequence: 1 }, logId: 'late-log' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(streaming.snapshot().session?.id, otherId);
  assert.equal(streaming.snapshot().stream.cursor, 0);
  assert.equal(streaming.snapshot().stream.events.length, 0);
  streaming.dispose();
});

test('Open响应失联保留最后日志，只能显式目录定位恢复，不自动重提', async () => {
  let opens = 0;
  const delayed = deferred<ApiResult<unknown>>();
  const streaming = createAiStreaming(gateway({ open: async () => { opens++; return delayed.promise; } }));
  await streaming.refreshDefinitions(signal());
  const controller = new AbortController();
  const opening = streaming.open({ project_id: 'demo', prompt: '只提交一次' }, controller.signal);
  controller.abort();
  await assert.rejects(opening, ApiError);
  assert.equal(streaming.snapshot().session, null);
  delayed.resolve({ data: info({ status: 'opening' }), logId: 'lost-open-log' });
  await new Promise((resolve) => setImmediate(resolve));
  await streaming.refreshRecords(signal());
  assert.equal(streaming.snapshot().records[0]?.id, sessionId);
  await streaming.resume(sessionId, { project_id: 'demo' }, signal());
  assert.equal(opens, 1);
  assert.equal(streaming.snapshot().logs.records, 'records-log');
  assert.equal(streaming.snapshot().logs.resume, 'query-log');
  streaming.dispose();
});

test('坏订阅隔离，订阅重入clear不发布或返回旧选择', async () => {
  const streaming = createAiStreaming(gateway());
  streaming.subscribe(() => { throw new Error('订阅失败'); });
  let cleared = false;
  streaming.subscribe((snapshot) => {
    if (!cleared && snapshot.session !== null) { cleared = true; streaming.clear(); }
  });
  await assert.rejects(streaming.resume(sessionId, { project_id: 'demo' }, signal()), (error: unknown) => error instanceof ApiError && error.kind === 'cancelled');
  assert.equal(streaming.snapshot().session, null);
  assert.equal(streaming.snapshot().pending.length, 0);
  streaming.dispose();
});

test('业务行包含换行最多512KiB，累计规范流最多4MiB，限额错误保持有限消息', () => {
  const line = new AiStreamDecoder(null);
  assert.throws(() => {
    for (let sequence = 1; sequence <= 64; sequence++) line.append({ sequence, stream: 'stdout', bytes: Array.from(new Uint8Array(8192).fill(32)) }, 'line-limit-log');
  }, (error: unknown) => error instanceof ApiError && error.logId === 'line-limit-log');
  const decoder = new AiStreamDecoder(null);
  const value = { format_version: 1, type: 'item.updated', item: { id: 'item_1', type: 'reasoning', text: '文'.repeat(160000) } };
  assert.throws(() => {
    for (const chunk of chunks([events()[0], events()[1], ...Array.from({ length: 9 }, () => value)], 8192)) decoder.append(chunk, 'total-limit-log');
  }, (error: unknown) => error instanceof ApiError && error.logId === 'total-limit-log' && error.message.length < 100);
});

test('目录刷新失败撤销新Open入口，历史查询恢复继续使用真实会话ID', async () => {
  let unavailable = false;
  const streaming = createAiStreaming(gateway({ definitions: async () => {
    if (unavailable) throw new ApiError('http', 'catalog_unavailable', '目录暂不可用', 503, 'catalog-failure-log');
    return { data: definitions(), logId: 'catalog-log' };
  } }));
  await streaming.refreshDefinitions(signal());
  unavailable = true;
  await assert.rejects(streaming.refreshDefinitions(signal()), ApiError);
  assert.equal(streaming.snapshot().definitions, null);
  assert.throws(() => streaming.open({ project_id: 'demo', prompt: '不能用旧目录提交' }, signal()), ApiError);
  await streaming.resume(sessionId, { project_id: 'demo' }, signal());
  await streaming.query(signal());
  assert.equal(streaming.snapshot().logs.definitions, 'catalog-failure-log');
  assert.equal(streaming.snapshot().logs.query, 'query-log');
  streaming.dispose();
});

test('完整JSONL也不能掩盖未确认清理、公开错误和错误项目终态', async () => {
  const source = chunks();
  const completions: NonNullable<SessionInfo['completion']>[] = [
    { outcome: { result: result(), artifacts: [], error: null }, cleanup: 'failed', process_exited: true, failure: null, sequence: 8 },
    { outcome: { result: result(), artifacts: [], error: '公开有限错误' }, cleanup: 'complete', process_exited: true, failure: null, sequence: 8 },
    { outcome: { result: result(), artifacts: [], error: null }, cleanup: 'complete', process_exited: true, failure: { code: 'failed', message: '失败' }, sequence: 8 },
    { outcome: { result: { ...result(), project_id: 'other' }, artifacts: [], error: null }, cleanup: 'complete', process_exited: true, failure: null, sequence: 8 },
  ];
  for (const completion of completions) {
    const streaming = createAiStreaming(gateway({ output: async () => ({ data: { session: finished(source.length, { completion }), chunks: source, next_sequence: source.length }, logId: 'invalid-finished-log' }) }));
    await streaming.resume(sessionId, { project_id: 'demo' }, signal());
    await assert.rejects(streaming.readOutput({}, signal()), (error: unknown) => error instanceof ApiError && error.logId === 'invalid-finished-log');
    assert.equal(streaming.snapshot().stream.providerCompleted, true);
    assert.equal(streaming.snapshot().result, null);
    assert.equal(streaming.snapshot().session?.completion?.cleanup, completion.cleanup);
    streaming.dispose();
  }
});

test('轮询定时等待立即取消并保留最后输出日志，未调用服务器cancel', async () => {
  let cancels = 0;
  const firstPoll = deferred<void>();
  const streaming = createAiStreaming(gateway({ output: async () => {
    firstPoll.resolve();
    return { data: { session: info(), chunks: [], next_sequence: 0 }, logId: 'poll-output-log' };
  }, cancel: async () => { cancels++; throw new Error('禁止自动cancel'); } }), { pollIntervalMs: 60000 });
  await streaming.resume(sessionId, { project_id: 'demo' }, signal());
  await streaming.readOutput({}, signal());
  const controller = new AbortController();
  const waiting = streaming.pollOutput({}, controller.signal);
  await firstPoll.promise;
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(waiting, (error: unknown) => error instanceof ApiError && error.kind === 'cancelled' && error.logId === 'poll-output-log');
  assert.equal(streaming.snapshot().logs.output, 'poll-output-log');
  assert.equal(streaming.snapshot().pending.length, 0);
  assert.equal(cancels, 0);
  streaming.dispose();
});
