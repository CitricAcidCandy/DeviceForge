import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiSdkStreaming, createHttpAiSdkStreaming } from '../src/features/ai-sdk-streaming/index.ts';
import { AiSdkStreamDecoder } from '../src/features/ai-sdk-streaming/services/decoder.ts';
import { ApiError, createApiClient } from '../src/services/api/index.ts';
import type { ApiResult, SessionDefinitions, SessionGateway, SessionInfo, SessionOutputPage } from '../src/services/api/index.ts';
import { deferred, requestUrl, signal, success } from './fixtures.ts';

const sessionId = '12345678-1234-1234-1234-123456789abc';
const threadId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const operation = 'plugin.ai-sdk.sdk.stream';
function info(changes: Partial<SessionInfo> = {}): SessionInfo {
  return { id: sessionId, operation, plugin_id: 'ai-sdk', generation: 'generation-1', created_at: 1, status: 'running', output_sequence: 0, completion: null, ...changes };
}
function result(text = '你好🙂', turns = '1') {
  return { provider: 'codex_sdk', sdk_version: '0.162.1', project_id: 'demo', thread_id: threadId, text, turns, resource_scope: 'sdk_worker_proxy_and_cli' };
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
  return { revision: 1, sessions: [{ id: operation, title: 'SDK实时输出', input_schema: { type: 'object' }, execution: { api_version: 1, source: 'declared', total_timeout_ms: 600000 } }] };
}
function gateway(changes: Partial<SessionGateway> = {}): SessionGateway {
  return {
    definitions: async () => ({ data: definitions(), logId: 'definitions-log' }),
    list: async () => ({ data: [info()], logId: 'records-log' }),
    open: async () => ({ data: info({ status: 'opening' }), logId: 'open-log' }),
    get: async (id) => ({ data: info({ id }), logId: 'query-log' }),
    output: async () => ({ data: { session: info(), chunks: [], next_sequence: 0 }, logId: 'output-log' }),
    send: async () => { throw new Error('不允许额外Input'); },
    eof: async () => { throw new Error('不自动EOF'); },
    cancel: async (id) => ({ data: info({ id, status: 'stopping' }), logId: 'cancel-log' }),
    remove: async () => { throw new Error('不自动删除'); },
    ...changes,
  };
}
function rejectedEvents(source: unknown[], expectedThread: string | null = null): void {
  assert.throws(() => {
    const decoder = new AiSdkStreamDecoder(expectedThread);
    for (const chunk of chunks(source)) decoder.append(chunk, 'invalid-log');
  }, (error: unknown) => error instanceof ApiError && error.logId === 'invalid-log' && !error.message.includes('PRIVATE-DIAGNOSTIC'));
}

test('逐字节UTF-8与CRLF跨片解析，完整快照替换并分别保留SDK线程与Session', () => {
  const source = chunks(events(), 1);
  const decoder = new AiSdkStreamDecoder(null, true);
  for (const chunk of source) decoder.append(chunk, 'stream-log');
  const view = decoder.snapshot();
  assert.equal(view.cursor, source.length);
  assert.equal(view.events.length, 6);
  assert.equal(view.text, '你好🙂');
  assert.equal(view.items[0]?.item.text, '你好🙂');
  assert.equal(view.turnCompleted, true);
  assert.equal(view.threadId, threadId);
  assert.equal(view.events[0]?.firstSequence, 1);
  assert.ok((view.events[0]?.sequence ?? 0) > 1);
  assert.deepEqual(view.chunks, source);
  assert.ok(Object.isFrozen(view.chunks[0]?.bytes));
  assert.deepEqual(decoder.complete(result(), 'demo', 'completion-log'), result());
});

test('SDK恢复也强制一次thread.started，顺序、线程、条目别名与终态固定', () => {
  rejectedEvents(events().slice(1), threadId);
  for (const source of [
    [events()[0], events()[0]],
    [events()[1], events()[0]],
    [events()[0], events()[1], events()[1]],
    [events()[0], events()[1], { format_version: 1, type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'ok' } }],
    [events()[0], events()[1], events()[2], { format_version: 1, type: 'item.completed', item: { id: 'item_1', type: 'reasoning', text: 'ok' } }],
    [events()[0], events()[1], events()[2], events()[5]],
    [...events(), events()[5]],
    [events()[0], events()[1], events()[4], events()[3]],
    [events()[0], events()[1], events()[4], events()[4]],
  ]) rejectedEvents(source);
  rejectedEvents([{ format_version: 1, type: 'thread.started', thread_id: sessionId }], threadId);
  rejectedEvents([{ format_version: 1, type: 'thread.started', thread_id: threadId.toUpperCase() }]);
});

test('七类条目可首次更新或完成，正文按完成顺序合并而非开始顺序', () => {
  const values: unknown[] = [events()[0], events()[1]];
  for (const [index, type] of ['reasoning', 'command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'todo_list'].entries()) {
    values.push({ format_version: 1, type: 'item.completed', item: { id: `item_${index + 1}`, type, status: 'completed', ...(type === 'reasoning' ? { text: '推理[已隐藏]' } : {}) } });
  }
  values.push(
    { format_version: 1, type: 'item.updated', item: { id: 'item_7', type: 'agent_message', text: '旧正文', status: 'in_progress' } },
    { format_version: 1, type: 'item.completed', item: { id: 'item_8', type: 'agent_message', text: '先完成' } },
    { format_version: 1, type: 'item.completed', item: { id: 'item_7', type: 'agent_message', text: '后完成', status: 'completed' } },
    events()[5],
  );
  const decoder = new AiSdkStreamDecoder(threadId);
  for (const chunk of chunks(values)) decoder.append(chunk, null);
  assert.equal(decoder.snapshot().text, '先完成\n后完成');
  assert.equal(decoder.snapshot().items.length, 8);
  assert.equal(decoder.snapshot().items[6]?.item.text, '后完成');
  assert.deepEqual(decoder.complete(result('先完成\n后完成', '4'), 'demo', null), result('先完成\n后完成', '4'));
});

test('非法UTF-8与非精确事件字段被拒绝，错误不包含原诊断', () => {
  for (const value of [
    { format_version: 2, type: 'turn.started' },
    { format_version: 1, type: 'error', details: 'PRIVATE-DIAGNOSTIC' },
    { format_version: 1, type: 'thread.started', thread_id: threadId, credential: 'PRIVATE-DIAGNOSTIC' },
    { format_version: 1, type: 'turn.started', usage: {} },
    { format_version: 1, type: 'item.completed', item: { id: 'item_1', type: 'command_execution', text: 'PRIVATE-DIAGNOSTIC' } },
    { format_version: 1, type: 'item.completed', item: { id: 'provider_1', type: 'agent_message', text: 'ok' } },
    { format_version: 1, type: 'item.completed', item: { id: 'item_1', type: 'image', text: 'ok' } },
    { format_version: 1, type: 'item.completed', item: { id: 'item_1', type: 'agent_message', status: 'cancelled', text: 'ok' } },
    { format_version: 1, type: 'item.completed', item: { id: 'item_1', type: 'agent_message' } },
    { format_version: 1, type: 'item.updated', item: { id: 'item_1', type: 'reasoning', text: '\ud800' } },
    { format_version: 1, type: 'item.completed', item: { id: 'item_1', type: 'file_change', paths: ['PRIVATE-DIAGNOSTIC'] } },
  ]) rejectedEvents([events()[0], events()[1], value]);
  for (const bytes of [[0xc0, 0xaf, 10], [0xff, 10], [0xef, 0xbb, 0xbf, 123, 125, 10], [123, 10], [10]]) {
    assert.throws(() => new AiSdkStreamDecoder(null).append({ sequence: 1, stream: 'stdout', bytes }, null), ApiError);
  }
  assert.throws(() => new AiSdkStreamDecoder(null).append({ sequence: 2, stream: 'stdout', bytes: [] }, null), ApiError);
  assert.throws(() => new AiSdkStreamDecoder(null).append({ sequence: 1, stream: 'stderr', bytes: [10] }, null), ApiError);
});

test('SDK精确七字段结果匹配回答归属与u64，新线程只接受第一轮', () => {
  const decoder = new AiSdkStreamDecoder(null, true);
  for (const chunk of chunks()) decoder.append(chunk, null);
  for (const data of [
    result('别的正文'), { ...result(), project_id: 'other' }, { ...result(), thread_id: sessionId },
    { ...result(), thread_id: threadId.toUpperCase() }, { ...result(), turns: 1 }, result('你好🙂', '0'),
    result('你好🙂', '01'), result('你好🙂', '18446744073709551616'), result('你好🙂', '2'),
    { ...result(), provider: 'codex_cli' }, { ...result(), sdk_version: '0.163.0' },
    { ...result(), resource_scope: 'direct_process' }, { ...result(), stream_format_version: 1 },
  ]) assert.throws(() => decoder.complete(data, 'demo', 'finished-log'), ApiError);
  const resumed = new AiSdkStreamDecoder(threadId);
  for (const chunk of chunks()) resumed.append(chunk, null);
  assert.deepEqual(resumed.complete(result('你好🙂', '18446744073709551615'), 'demo', null), result('你好🙂', '18446744073709551615'));
  decoder.append({ sequence: decoder.snapshot().cursor + 1, stream: 'stdout', bytes: [0xe4] }, null);
  assert.throws(() => decoder.complete(result(), 'demo', null), ApiError);
});

test('真实HTTP客户端只提交一次SDK Open，读完整Finished之前不发布成功', async () => {
  const source = chunks();
  const requests: { path: string; method: string; body: unknown }[] = [];
  const client = createApiClient({ baseUrl: 'http://localhost:3000', transport: async (input, init) => {
    const url = requestUrl(input);
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    requests.push({ path: url.pathname + url.search, method: init?.method ?? 'GET', body });
    if (url.pathname.endsWith('/session-definitions')) return success(definitions(), 'definitions-log');
    if (url.pathname === '/api/v2/sessions') return success(info({ status: 'opening' }), 'open-log', 202);
    if (url.pathname.endsWith('/output')) {
      const after = Number(url.searchParams.get('after')); const limit = Number(url.searchParams.get('limit'));
      const batch = source.slice(after, after + limit);
      return success({ session: finished(source.length), chunks: batch, next_sequence: after + batch.length }, 'output-log');
    }
    throw new Error('未授权的HTTP调用');
  } });
  const streaming = createHttpAiSdkStreaming(client, { pollIntervalMs: 0 });
  assert.throws(() => streaming.open({ project_id: 'demo', prompt: '你好' }, signal()), ApiError);
  await streaming.refreshDefinitions(signal());
  await streaming.open({ project_id: 'demo', prompt: '你好' }, signal());
  await streaming.readOutput({ limit: 1 }, signal());
  assert.equal(streaming.snapshot().session?.status, 'finished');
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

test('完整turn.completed与最后回答仍不能代替协议5 Finished', async () => {
  const source = chunks(); let closed = false;
  const streaming = createAiSdkStreaming(gateway({ output: async (_id, query) => ({
    data: { session: closed ? finished(source.length) : info({ output_sequence: source.length }), chunks: source.slice(query.after ?? 0), next_sequence: source.length }, logId: 'events-log',
  }) }));
  await streaming.resume(sessionId, { project_id: 'demo' }, signal());
  await streaming.readOutput({}, signal());
  assert.equal(streaming.snapshot().stream.turnCompleted, true);
  assert.equal(streaming.snapshot().stream.text, result().text);
  assert.equal(streaming.snapshot().result, null);
  closed = true;
  await streaming.readOutput({}, signal());
  assert.deepEqual(streaming.snapshot().result, result());
  streaming.dispose();
});

test('输入遵守Rust字符和空白规则，拒绝null线程、未知字段及孤立代理码元', async () => {
  let opens = 0; const inputs: unknown[] = [];
  const streaming = createAiSdkStreaming(gateway({ open: async (input) => { opens++; inputs.push(input); return { data: info({ status: 'opening' }), logId: 'open-log' }; } }));
  await streaming.refreshDefinitions(signal());
  const invalid: unknown[] = [
    { project_id: '../demo', prompt: 'ok' }, { project_id: 'demo', prompt: '\u0085' },
    { project_id: 'demo', prompt: '\ud800' }, { project_id: 'demo', prompt: '🙂'.repeat(131073) },
    { project_id: 'demo', prompt: 'ok', thread_id: null }, { project_id: 'demo', prompt: 'ok', thread_id: undefined },
    { project_id: 'demo', prompt: 'ok', stream_output: true },
  ];
  for (const value of invalid) {
    if (typeof value === 'object' && value !== null && 'project_id' in value && 'prompt' in value && typeof value.project_id === 'string' && typeof value.prompt === 'string') {
      const projectId = value.project_id; const prompt = value.prompt;
      assert.throws(() => streaming.open({ ...value, project_id: projectId, prompt }, signal()), ApiError);
    }
  }
  await streaming.open({ project_id: 'demo', prompt: '🙂'.repeat(131072), thread_id: threadId.toUpperCase() }, signal());
  await streaming.open({ project_id: 'demo', prompt: '\ufeff\0' }, signal());
  assert.equal(opens, 2);
  assert.deepEqual(inputs[0], { operation, input: { project_id: 'demo', prompt: '🙂'.repeat(131072), thread_id: threadId } });
  streaming.dispose();
});

test('跨Session、插件、代次、创建时间、缺口及stderr整页拒绝并保持原游标', async () => {
  const prefix = chunks([events()[0]], 8192);
  const badPages: unknown[] = [
    { session: info({ id: threadId, output_sequence: 1 }), chunks: prefix, next_sequence: 1 },
    { session: info({ plugin_id: 'ai-assistant', output_sequence: 1 }), chunks: prefix, next_sequence: 1 },
    { session: info({ operation: 'plugin.ai-assistant.cli.stream', output_sequence: 1 }), chunks: prefix, next_sequence: 1 },
    { session: info({ generation: 'generation-2', output_sequence: 1 }), chunks: prefix, next_sequence: 1 },
    { session: info({ created_at: 2, output_sequence: 1 }), chunks: prefix, next_sequence: 1 },
    { session: info({ output_sequence: 2 }), chunks: [{ sequence: 2, stream: 'stdout', bytes: [10] }], next_sequence: 2 },
    { session: info({ output_sequence: 1 }), chunks: [], next_sequence: 0 },
    { session: info({ output_sequence: 2 }), chunks: [...prefix, { sequence: 2, stream: 'stderr', bytes: [10] }], next_sequence: 2 },
    { session: info({ output_sequence: 2 }), chunks: [...prefix, { sequence: 2, stream: 'stdout', bytes: [255, 10] }], next_sequence: 2 },
    { session: info({ output_sequence: 1 }), chunks: prefix, next_sequence: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const page of badPages) {
    const streaming = createAiSdkStreaming(gateway({ output: async () => ({ data: page, logId: 'bad-page-log' }) }));
    await streaming.resume(sessionId, { project_id: 'demo' }, signal());
    await assert.rejects(streaming.readOutput({}, signal()), (error: unknown) => error instanceof ApiError && error.logId === 'bad-page-log');
    assert.equal(streaming.snapshot().stream.cursor, 0);
    assert.equal(streaming.snapshot().stream.events.length, 0);
    assert.equal(streaming.snapshot().logs.output, 'bad-page-log');
    streaming.dispose();
  }
});

test('错误或未确认清理的Finished保留实际清理证据与原字节，不发布成功', async () => {
  const source = chunks();
  const completions: NonNullable<SessionInfo['completion']>[] = [
    { outcome: { result: result(), artifacts: [], error: null }, cleanup: 'failed', process_exited: true, failure: null },
    { outcome: { result: result(), artifacts: [], error: null }, cleanup: 'unconfirmed', process_exited: false, failure: null },
    { outcome: { result: result(), artifacts: [], error: '公开有限错误' }, cleanup: 'complete', process_exited: true, failure: null },
    { outcome: { result: result(), artifacts: [], error: null }, cleanup: 'complete', process_exited: true, failure: { code: 'failed', message: '失败' } },
    { outcome: { result: { ...result(), project_id: 'other' }, artifacts: [], error: null }, cleanup: 'complete', process_exited: true, failure: null },
  ];
  for (const completion of completions) {
    const streaming = createAiSdkStreaming(gateway({ output: async () => ({ data: { session: finished(source.length, { completion }), chunks: source, next_sequence: source.length }, logId: 'invalid-finished-log' }) }));
    await streaming.resume(sessionId, { project_id: 'demo' }, signal());
    await assert.rejects(streaming.readOutput({}, signal()), (error: unknown) => error instanceof ApiError && error.logId === 'invalid-finished-log');
    assert.equal(streaming.snapshot().result, null);
    assert.equal(streaming.snapshot().stream.turnCompleted, true);
    assert.deepEqual(streaming.snapshot().stream.chunks, source);
    assert.deepEqual(streaming.snapshot().session?.completion, completion);
    streaming.dispose();
  }
});

test('失败Finished可清除不完整UTF-8残行，成功Finished拒绝残行及缺少完成事件', async () => {
  const partial = chunks([events()[0]], 8192);
  partial.push({ sequence: 2, stream: 'stdout', bytes: [0xe4] });
  const completion: SessionInfo['completion'] = { outcome: { result: null, artifacts: [], error: 'SDK轮次已取消' }, cleanup: 'unconfirmed', process_exited: false, sequence: 3, failure: null };
  const failed = createAiSdkStreaming(gateway({ output: async () => ({ data: { session: finished(2, { completion }), chunks: partial, next_sequence: 2 }, logId: 'failed-output-log' }) }));
  await failed.resume(sessionId, { project_id: 'demo' }, signal());
  await assert.rejects(failed.readOutput({}, signal()), (error: unknown) => error instanceof ApiError && error.code === 'ai_sdk_stream_failed');
  assert.equal(failed.snapshot().stream.cursor, 2);
  assert.equal(failed.snapshot().stream.pendingBytes, 0);
  assert.deepEqual(failed.snapshot().stream.chunks, partial);
  assert.deepEqual(failed.snapshot().session?.completion, completion);
  failed.dispose();
  for (const source of [partial, chunks(events().slice(0, -1))]) {
    const streaming = createAiSdkStreaming(gateway({ output: async () => ({ data: { session: finished(source.length), chunks: source, next_sequence: source.length }, logId: 'incomplete-output-log' }) }));
    await streaming.resume(sessionId, { project_id: 'demo' }, signal());
    await assert.rejects(streaming.readOutput({}, signal()), ApiError);
    assert.equal(streaming.snapshot().result, null);
    streaming.dispose();
  }
});

test('取消等待后同Session恢复保留游标，不重提提示词、不自动Input或cancel', async () => {
  const source = chunks(); const cursors: number[] = [];
  let opens = 0; let inputs = 0; let cancels = 0; let hanging = true;
  const delayed = deferred<ApiResult<unknown>>();
  const streaming = createAiSdkStreaming(gateway({
    open: async () => { opens++; return { data: info({ status: 'opening' }), logId: 'open-log' }; },
    get: async () => ({ data: info({ output_sequence: source.length }), logId: 'resume-log' }),
    output: async (_id, query) => {
      const after = query.after ?? 0; const limit = query.limit ?? 50; cursors.push(after);
      if (after > 0 && hanging) return delayed.promise;
      const batch = source.slice(after, after + limit);
      return { data: { session: hanging ? info({ output_sequence: source.length }) : finished(source.length), chunks: batch, next_sequence: after + batch.length }, logId: 'stream-log' };
    },
    send: async () => { inputs++; throw new Error('禁止Input'); },
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
  assert.equal(cursors[2], 1);
  assert.equal(opens, 1); assert.equal(inputs, 0); assert.equal(cancels, 0);
  streaming.dispose();
});

test('历史恢复新实例从零读取，不猜原线程轮次且不需要动态目录', async () => {
  const source = chunks(); const cursors: number[] = [];
  const completion: SessionInfo['completion'] = { outcome: { result: result('你好🙂', '9'), artifacts: [], error: null }, cleanup: 'complete', process_exited: true, failure: null };
  const streaming = createAiSdkStreaming(gateway({
    definitions: async () => { throw new Error('历史恢复不要求目录'); },
    open: async () => { throw new Error('恢复不能Open'); },
    get: async () => ({ data: finished(source.length, { completion }), logId: 'history-log' }),
    output: async (_id, query) => {
      const after = query.after ?? 0; cursors.push(after);
      return { data: { session: finished(source.length, { completion }), chunks: source.slice(after), next_sequence: source.length }, logId: 'history-output-log' };
    },
  }));
  await streaming.resume(sessionId.toUpperCase(), { project_id: 'demo', thread_id: threadId.toUpperCase() }, signal());
  assert.equal(streaming.snapshot().result, null);
  await streaming.readOutput({}, signal());
  assert.deepEqual(cursors, [0]);
  assert.deepEqual(streaming.snapshot().result, result('你好🙂', '9'));
  streaming.dispose();
});

test('Open响应失联后显式记录查询恢复，不自动重提或接纳晚到Open', async () => {
  let opens = 0; const delayed = deferred<ApiResult<unknown>>();
  const streaming = createAiSdkStreaming(gateway({ open: async () => { opens++; return delayed.promise; } }));
  await streaming.refreshDefinitions(signal());
  const controller = new AbortController();
  const opening = streaming.open({ project_id: 'demo', prompt: '只提交一次' }, controller.signal);
  controller.abort(); await assert.rejects(opening, ApiError);
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

test('clear与dispose结束忽略信号的等待，晚到成功和拒绝均被隔离', async () => {
  for (const disposal of [false, true]) for (const rejection of [false, true]) {
    const delayed = deferred<ApiResult<unknown>>();
    const streaming = createAiSdkStreaming(gateway({ output: async () => delayed.promise }));
    await streaming.resume(sessionId, { project_id: 'demo' }, signal());
    let notifications = 0; streaming.subscribe(() => { notifications++; });
    const waiting = streaming.readOutput({}, signal());
    if (disposal) streaming.dispose(); else streaming.clear();
    await assert.rejects(waiting, (error: unknown) => error instanceof ApiError && error.kind === 'cancelled');
    const before = notifications;
    if (rejection) delayed.reject(new Error('延迟失败')); else delayed.resolve({ data: { session: info(), chunks: [], next_sequence: 0 }, logId: 'late-log' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(notifications, before);
    assert.equal(streaming.snapshot().stream.cursor, 0);
    assert.equal(streaming.snapshot().pending.length, 0);
    if (!disposal) { assert.equal(streaming.snapshot().session, null); streaming.dispose(); }
  }
});

test('显式cancel观察Stopping，晚到Running不回退，Finished后拒绝终态与序号漂移', async () => {
  const source = chunks(); const delayed = deferred<ApiResult<unknown>>();
  let waiting = true; let observation: SessionInfo = info({ output_sequence: source.length });
  const streaming = createAiSdkStreaming(gateway({
    output: async (_id, query) => waiting ? delayed.promise : { data: { session: finished(source.length), chunks: source.slice(query.after ?? 0), next_sequence: source.length }, logId: 'final-log' },
    get: async () => ({ data: observation, logId: 'query-log' }),
  }));
  await streaming.resume(sessionId, { project_id: 'demo' }, signal());
  const output = streaming.readOutput({}, signal());
  await streaming.cancel(signal());
  delayed.resolve({ data: { session: info({ output_sequence: source.length }), chunks: source, next_sequence: source.length }, logId: 'late-running-log' });
  await output;
  assert.equal(streaming.snapshot().session?.status, 'stopping');
  assert.equal(streaming.snapshot().result, null);
  assert.equal(streaming.snapshot().logs.cancel, 'cancel-log');
  waiting = false;
  await streaming.readOutput({}, signal());
  assert.deepEqual(streaming.snapshot().result, result());
  const drift: SessionInfo[] = [
    finished(source.length, { completion: { outcome: { result: result('篡改'), artifacts: [], error: null }, cleanup: 'complete', process_exited: true, failure: null } }),
    finished(source.length - 1),
    info({ output_sequence: source.length + 1 }),
  ];
  for (const incoming of drift) {
    observation = incoming;
    await assert.rejects(streaming.query(signal()), ApiError);
    assert.deepEqual(streaming.snapshot().result, result());
    assert.equal(streaming.snapshot().session?.output_sequence, source.length);
  }
  observation = info({ output_sequence: source.length });
  await streaming.query(signal());
  assert.equal(streaming.snapshot().session?.status, 'finished');
  streaming.dispose();
});

test('切换Session隔离旧输出，同ID恢复拒绝更改项目或已观测SDK线程', async () => {
  const prefix = chunks([events()[0]], 8192); const delayed = deferred<ApiResult<unknown>>();
  const otherId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'; let delaying = false;
  const streaming = createAiSdkStreaming(gateway({ output: async () => delaying ? delayed.promise : { data: { session: info({ output_sequence: 1 }), chunks: prefix, next_sequence: 1 }, logId: 'first-log' } }));
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

test('目录刷新失败撤销新Open，普通SDK助手和CLI目录不能替代实时贡献', async () => {
  let mode = 'sdk';
  const streaming = createAiSdkStreaming(gateway({ definitions: async () => {
    if (mode === 'failed') throw new ApiError('http', 'catalog_unavailable', '目录暂不可用', 503, 'catalog-failure-log');
    const data = definitions();
    if (mode === 'other') data.sessions = data.sessions.flatMap((entry) => ['plugin.ai-sdk.sdk.single', 'plugin.ai-sdk.assistant.run', 'plugin.ai-assistant.cli.stream'].map((id) => ({ ...entry, id })));
    return { data, logId: 'catalog-log' };
  } }));
  await streaming.refreshDefinitions(signal());
  mode = 'failed';
  await assert.rejects(streaming.refreshDefinitions(signal()), ApiError);
  assert.equal(streaming.snapshot().definitions, null);
  assert.throws(() => streaming.open({ project_id: 'demo', prompt: '不能用旧目录' }, signal()), ApiError);
  await streaming.resume(sessionId, { project_id: 'demo' }, signal());
  await streaming.query(signal());
  assert.equal(streaming.snapshot().logs.definitions, 'catalog-failure-log');
  mode = 'other';
  await streaming.refreshDefinitions(signal());
  assert.throws(() => streaming.open({ project_id: 'demo', prompt: '必须精确贡献' }, signal()), ApiError);
  streaming.dispose();
});

test('目录与记录拒绝重复身份，记录只保留SDK实时会话且刷新失败撤销旧记录', async () => {
  let bad = false;
  const streaming = createAiSdkStreaming(gateway({
    definitions: async () => { const data = definitions(); if (bad) data.sessions.push(...data.sessions); return { data, logId: 'definitions-log' }; },
    list: async () => ({ data: bad ? [info(), info({ id: sessionId.toUpperCase() })] : [info(), info({ id: threadId, operation: 'plugin.ai-assistant.cli.stream', plugin_id: 'ai-assistant' })], logId: 'records-log' }),
  }));
  await streaming.refreshDefinitions(signal()); await streaming.refreshRecords(signal());
  assert.equal(streaming.snapshot().records.length, 1);
  bad = true;
  await assert.rejects(streaming.refreshDefinitions(signal()), ApiError);
  await assert.rejects(streaming.refreshRecords(signal()), ApiError);
  assert.equal(streaming.snapshot().definitions, null);
  assert.equal(streaming.snapshot().records.length, 0);
  streaming.dispose();
});

test('订阅异常隔离，重入clear不能返回或发布已经撤销的Session', async () => {
  const streaming = createAiSdkStreaming(gateway());
  streaming.subscribe(() => { throw new Error('订阅失败'); });
  let cleared = false;
  streaming.subscribe((snapshot) => { if (!cleared && snapshot.session !== null) { cleared = true; streaming.clear(); } });
  await assert.rejects(streaming.resume(sessionId, { project_id: 'demo' }, signal()), (error: unknown) => error instanceof ApiError && error.kind === 'cancelled');
  assert.equal(streaming.snapshot().session, null);
  assert.equal(streaming.snapshot().pending.length, 0);
  streaming.dispose();
});

test('轮询定时等待立即取消并保留日志，不发送服务器cancel', async () => {
  let cancels = 0; const firstPoll = deferred<void>();
  const streaming = createAiSdkStreaming(gateway({
    output: async () => { firstPoll.resolve(); return { data: { session: info(), chunks: [], next_sequence: 0 }, logId: 'poll-output-log' }; },
    cancel: async () => { cancels++; throw new Error('禁止自动cancel'); },
  }), { pollIntervalMs: 60000 });
  await streaming.resume(sessionId, { project_id: 'demo' }, signal());
  await streaming.readOutput({}, signal());
  const controller = new AbortController(); const waiting = streaming.pollOutput({}, controller.signal);
  await firstPoll.promise; await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(waiting, (error: unknown) => error instanceof ApiError && error.kind === 'cancelled' && error.logId === 'poll-output-log');
  assert.equal(streaming.snapshot().pending.length, 0);
  assert.equal(cancels, 0);
  streaming.dispose();
});

test('公开单行含换行最多512KiB，全部流4MiB，完成回答合并最多512KiB', () => {
  const limit = 512 * 1024;
  const item = { format_version: 1, type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: '' } };
  const overhead = new TextEncoder().encode(JSON.stringify(item) + '\r\n').length;
  const text = 'x'.repeat(limit - overhead);
  const exact = new AiSdkStreamDecoder(null);
  for (const chunk of chunks([events()[0], events()[1], { ...item, item: { ...item.item, text } }, events()[5]], 8192)) exact.append(chunk, null);
  assert.deepEqual(exact.complete(result(text), 'demo', null), result(text));
  const line = new AiSdkStreamDecoder(null);
  assert.throws(() => {
    for (let sequence = 1; sequence <= 64; sequence++) line.append({ sequence, stream: 'stdout', bytes: Array.from(new Uint8Array(8192).fill(32)) }, 'line-limit-log');
  }, (error: unknown) => error instanceof ApiError && error.logId === 'line-limit-log');
  const total = new AiSdkStreamDecoder(null);
  const update = { format_version: 1, type: 'item.updated', item: { id: 'item_1', type: 'reasoning', text: '文'.repeat(160000) } };
  assert.throws(() => {
    for (const chunk of chunks([events()[0], events()[1], ...Array.from({ length: 9 }, () => update)], 8192)) total.append(chunk, 'total-limit-log');
  }, (error: unknown) => error instanceof ApiError && error.logId === 'total-limit-log' && error.message.length < 100);
  const merged = new AiSdkStreamDecoder(null);
  assert.throws(() => {
    for (const chunk of chunks([
      events()[0], events()[1], { ...item, item: { ...item.item, text: 'x'.repeat(300000) } },
      { ...item, item: { ...item.item, id: 'item_2', text: 'x'.repeat(300000) } },
    ], 8192)) merged.append(chunk, null);
  }, ApiError);
});

test('公开事件最多10000，分片8192字节，页长与轮询参数保持有限', async () => {
  const update = { format_version: 1, type: 'item.updated', item: { id: 'item_1', type: 'reasoning' } };
  const decoder = new AiSdkStreamDecoder(null);
  assert.throws(() => {
    for (const chunk of chunks([events()[0], events()[1], ...Array.from({ length: 9999 }, () => update)], 8192)) decoder.append(chunk, 'event-limit-log');
  }, (error: unknown) => error instanceof ApiError && error.logId === 'event-limit-log');
  assert.equal(decoder.snapshot().events.length, 10000);
  assert.throws(() => new AiSdkStreamDecoder(null).append({ sequence: 1, stream: 'stdout', bytes: Array.from(new Uint8Array(8193)) }, null), ApiError);
  assert.throws(() => new AiSdkStreamDecoder(null).append({ sequence: 65537, stream: 'stdout', bytes: [] }, null), ApiError);
  for (const pollIntervalMs of [-1, 60001, NaN, Infinity, 0.5]) assert.throws(() => createAiSdkStreaming(gateway(), { pollIntervalMs }), ApiError);
  const streaming = createAiSdkStreaming(gateway());
  await streaming.resume(sessionId, { project_id: 'demo' }, signal());
  for (const limit of [0, 101, NaN, Infinity, 0.5]) assert.throws(() => streaming.readOutput({ limit }, signal()), ApiError);
  streaming.dispose();
  assert.throws(() => streaming.query(signal()), ApiError);
  assert.throws(() => streaming.subscribe(() => {}), ApiError);
});

test('新线程Open不能借恢复绕过第一轮校验，已有线程Open允许后续轮次', async () => {
  const source = chunks();
  const completion: SessionInfo['completion'] = { outcome: { result: result('你好🙂', '2'), artifacts: [], error: null }, cleanup: 'complete', process_exited: true, failure: null };
  for (const existing of [false, true]) {
    const streaming = createAiSdkStreaming(gateway({
      get: async () => ({ data: info({ output_sequence: source.length }), logId: 'resume-log' }),
      output: async () => ({ data: { session: finished(source.length, { completion }), chunks: source, next_sequence: source.length }, logId: 'second-turn-log' }),
    }));
    await streaming.refreshDefinitions(signal());
    await streaming.open({ project_id: 'demo', prompt: '你好', ...(existing ? { thread_id: threadId } : {}) }, signal());
    await streaming.resume(sessionId, { project_id: 'demo' }, signal());
    if (existing) {
      await streaming.readOutput({}, signal());
      assert.deepEqual(streaming.snapshot().result, result('你好🙂', '2'));
    } else {
      await assert.rejects(streaming.readOutput({}, signal()), ApiError);
      assert.equal(streaming.snapshot().result, null);
    }
    streaming.dispose();
  }
});
