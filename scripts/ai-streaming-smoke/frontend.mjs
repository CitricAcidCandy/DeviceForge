import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { poll } from '../device-provider/client.mjs';
import { expectedResult, golden, operation, prompt, publicOnly } from './contracts.mjs';
import { assertSnapshot, finishCall, observeRunning, readyCall, release } from './fixtures.mjs';
import { adopt, finish, page, running, untilEvent } from './sessions.mjs';

export async function frontendRound(context) {
  const { createApiClient } = await import(pathToFileURL(join(context.root, 'frontend/src/shared/api/index.ts')).href);
  const { createHttpAiStreaming } = await import(pathToFileURL(join(context.root, 'frontend/src/features/ai-streaming/index.ts')).href);
  const factoryRequests = [];
  const transport = async (input, options) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    assert.equal(url.origin, context.host.client.base);
    const startedAt = new Date().toISOString();
    const response = await fetch(input, options);
    const logId = response.headers.get('x-deviceforge-log-id');
    assert.match(logId, /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/);
    context.host.client.logIds.add(logId);
    const summary = { client_method: 'frontend-factory', path: url.pathname + url.search, method: options?.method ?? 'GET',
      started_at: startedAt, status: response.status, log_id: logId, outcome: 'returned' };
    context.report.requests.push(summary);
    factoryRequests.push(summary);
    return response;
  };
  const client = createApiClient({ baseUrl: context.host.client.base, transport });
  const observer = createHttpAiStreaming(client, { pollIntervalMs: 10 });
  const history = createHttpAiStreaming(client, { pollIntervalMs: 10 });
  const signal = AbortSignal.timeout(30000), fixture = context.fixtures.frontend;
  try {
    const definitions = await observer.refreshDefinitions(signal);
    assert.deepEqual(definitions.data, await context.host.client.json('/api/v2/session-definitions'));
    const input = { project_id: fixture.label, prompt };
    const opened = await observer.open(input, signal);
    const entry = adopt(context, opened.data, { body: input, transport: 'http', caseId: '前端公开工厂真实服务轮次', logId: opened.logId });
    const call = await readyCall(context, fixture, 1, false, entry);
    await release(call, 'start');
    await untilEvent(context, entry, 'item.started');
    await poll(() => page(context, entry), () => entry.events.length === 7, '独立黄金增量事件');
    await poll(() => observer.readOutput({ limit: 1 }, signal), () => observer.snapshot().stream.events.length === 7, '真实前端增量解码');
    const incremental = observer.snapshot();
    assert.deepEqual(incremental.stream.events.map(value => value.event), golden(fixture.threadId).slice(0, 7));
    assert.deepEqual(incremental.stream.chunks, entry.chunks);
    assert.equal(incremental.stream.threadId, fixture.threadId);
    assert.equal(incremental.stream.providerCompleted, false);
    assert.equal(incremental.result, null);
    await release(call, 'continue');
    await untilEvent(context, entry, 'turn.completed');
    await poll(() => observer.readOutput({ limit: 1 }, signal), () => observer.snapshot().stream.providerCompleted, '真实前端提供者完成观测');
    await observer.query(signal);
    assert.equal(observer.snapshot().session.status, 'running');
    assert.equal(observer.snapshot().result, null);
    await running(context, entry);
    entry.provider_completion_observation = await observeRunning(call);
    await assertSnapshot(fixture, context.stateRoot, { turns: 0, uncertain: true });
    await release(call, 'exit');
    await finish(context, entry, { fixture, turns: 1, success: true });
    await finishCall(context, call, 0);
    await observer.query(signal);
    const expected = expectedResult(fixture.label, fixture.threadId, 1);
    assert.deepEqual(observer.snapshot().result, expected);
    assert.deepEqual(observer.snapshot().stream.events.map(value => value.event), golden(fixture.threadId));
    assert.deepEqual(observer.snapshot().stream.chunks, entry.chunks);
    const cursor = observer.snapshot().stream.cursor;
    await observer.resume(entry.id, { project_id: fixture.label, thread_id: fixture.threadId }, signal);
    assert.equal(observer.snapshot().stream.cursor, cursor);
    assert.deepEqual(observer.snapshot().result, expected);
    const records = await history.refreshRecords(signal);
    assert.ok(records.data.some(value => value.id === entry.id && value.status === 'finished'));
    await history.resume(entry.id, { project_id: fixture.label, thread_id: fixture.threadId }, signal);
    assert.equal(history.snapshot().session.status, 'finished');
    assert.equal(history.snapshot().stream.cursor, 0);
    assert.equal(history.snapshot().result, null);
    const restored = await history.pollOutput({ limit: 1 }, signal);
    assert.deepEqual(restored.data, expected);
    assert.deepEqual(history.snapshot().stream.chunks, entry.chunks);
    assert.deepEqual(history.snapshot().stream.events.map(value => value.event), golden(fixture.threadId));
    assert.equal(history.snapshot().stream.pendingBytes, 0);
    assert.equal(factoryRequests.filter(value => value.path === '/api/v2/sessions' && value.method === 'POST').length, 1);
    assert.ok(!factoryRequests.some(value => value.path.endsWith('/input') || value.path.endsWith('/cancel')));
    publicOnly(observer.snapshot().stream.events);
    context.report.frontend = { requests: factoryRequests, original_session_id: entry.id, original_thread_id: fixture.threadId,
      incremental_events: incremental.stream.events.length, same_id_resume_cursor: cursor, restored_result: restored.data,
      final_output_sequence: history.snapshot().stream.cursor, one_open_without_replay: true,
      consumed_chunks: entry.chunks.length, factory: 'createHttpAiStreaming', node_typescript_runtime: process.version };
    await writeFile(join(context.directory, 'frontend-consumption.json'), JSON.stringify({ incremental,
      final: observer.snapshot(), restored: history.snapshot() }, null, 2) + '\n', { flag: 'wx' });
    context.report.checks.push({ name: '真实前端工厂增量与Finished、同ID游标、历史重新消费且不重放', passed: true });
  } finally { observer.dispose(); history.dispose(); }
  await context.host.shutdown();
}
