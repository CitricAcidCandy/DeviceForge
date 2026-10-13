import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { poll } from '../device-provider/client.mjs';
import { answer, expectedResult, expectedThread, golden, prompt, publicOnly, updated } from './contracts.mjs';
import { runtimeStatus, candidate } from './cases.mjs';
import { completeCall, finishCall, readyCall, release } from './fixtures.mjs';
import { adopt, eventsUntil, finish } from './sessions.mjs';

async function factories(context) {
  const base = join(context.snapshotRoot, 'frontend/src');
  const { createApiClient } = await import(pathToFileURL(join(base, 'shared/api/index.ts')).href);
  const { createHttpAiSdk } = await import(pathToFileURL(join(base, 'features/ai-sdk/index.ts')).href);
  const { createHttpAiSdkStreaming } = await import(pathToFileURL(join(base, 'features/ai-sdk-streaming/index.ts')).href);
  const requests = [];
  const transport = async (input, options) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    assert.equal(url.origin, context.host.client.base);
    const startedAt = new Date().toISOString(), response = await fetch(input, options);
    const logId = response.headers.get('x-deviceforge-log-id');
    assert.match(logId, /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/);
    context.host.client.logIds.add(logId);
    const summary = { client_method: 'frontend-factory', path: url.pathname + url.search,
      method: options?.method ?? 'GET', started_at: startedAt, status: response.status, log_id: logId, outcome: 'returned' };
    context.report.requests.push(summary); requests.push(summary);
    if (summary.method === 'POST' && url.pathname === '/api/v2/jobs' && response.status === 202) {
      const body = JSON.parse(options.body), reply = await response.clone().json();
      assert.equal(reply.log_id, logId); assert.equal(reply.data.operation, body.operation);
      context.report.jobs.push({ id: reply.data.id, operation: body.operation, input: body.input,
        log_id: logId, expected_status: 'succeeded', transport: 'frontend-factory' });
    }
    return response;
  };
  const client = createApiClient({ baseUrl: context.host.client.base, transport });
  return { requests, ordinary: createHttpAiSdk(client, { pollIntervalMs: 10 }),
    observer: createHttpAiSdkStreaming(client, { pollIntervalMs: 10 }),
    history: createHttpAiSdkStreaming(client, { pollIntervalMs: 10 }) };
}

function ordinaryResult(context, value, expected) {
  assert.deepEqual(value.data, expected); assert.equal(value.job.status, 'succeeded');
  assert.deepEqual(value.job.result.artifacts, []); publicOnly(value.data);
  const entry = context.report.jobs.find(record => record.id === value.job.id);
  assert.ok(entry); assert.equal(value.submitLogId, entry.log_id); entry.history = value.job;
  assert.ok(context.host.client.logIds.has(value.logId)); return value;
}

async function frontendOrdinary(context, current) {
  const sdk = current.ordinary, signal = AbortSignal.timeout(60000), fixture = context.fixtures['frontend-ordinary'];
  await sdk.refreshOperations(signal);
  const beforeVerified = context.report.tools.length > 0;
  const status = sdk.runtimeStatus(signal); status.catch(() => {});
  await runtimeStatus(context, beforeVerified, status);
  const first = sdk.single({ project_id: fixture.label, prompt }, signal); first.catch(() => {});
  const call = await readyCall(context, fixture);
  await release(call, 'start'); await completeCall(call);
  const firstValue = ordinaryResult(context, await first, expectedResult(fixture.label, call.ready.thread_id, 1));
  await finishCall(context, call, 0);
  const thread = { project_id: fixture.label, thread_id: call.ready.thread_id };
  const second = sdk.turn({ ...thread, prompt }, signal); second.catch(() => {});
  const resumed = await readyCall(context, fixture, 2, { threadId: call.ready.thread_id });
  await release(resumed, 'start'); await completeCall(resumed);
  ordinaryResult(context, await second, expectedResult(fixture.label, call.ready.thread_id, 2));
  await finishCall(context, resumed, 0);
  ordinaryResult(context, await sdk.getThread(thread, signal), expectedThread(fixture, call.ready.thread_id, 2));
  ordinaryResult(context, await sdk.closeThread(thread, signal), expectedThread(fixture, call.ready.thread_id, 2, { closed: true }));
  const assistant = context.fixtures['frontend-assistant'];
  const pending = sdk.runAssistant({ project_id: assistant.label, user_prompt: prompt, stream_output: false }, signal);
  pending.catch(() => {}); const calls = [];
  for (let ordinal = 1; ordinal <= 4; ordinal++) {
    const active = await readyCall(context, assistant, ordinal, { assistant: true });
    await release(active, 'start'); await completeCall(active); calls.push(active);
  }
  ordinaryResult(context, await pending, { ...expectedResult(assistant.label, calls[0].ready.thread_id, 4, 'SDK四轮助手最终回答。'),
    assistant_turns: '4', stream_output: false });
  for (const active of calls) await finishCall(context, active, 0);
  const submitted = current.requests.filter(record => record.path === '/api/v2/jobs' && record.method === 'POST').length;
  const ticket = { id: firstValue.job.id, operation: firstValue.job.operation, submitLogId: firstValue.submitLogId };
  ordinaryResult(context, await sdk.resumeSingle(ticket, { project_id: fixture.label, prompt }, signal), firstValue.data);
  assert.equal(current.requests.filter(record => record.path === '/api/v2/jobs' && record.method === 'POST').length, submitted);
  context.report.frontend_ordinary = { factories: ['createApiClient', 'createHttpAiSdk'], six_methods_consumed: true,
    original_job_id: firstValue.job.id, history_resume_without_post: true, methods: ['runtimeStatus', 'single', 'turn', 'getThread', 'closeThread', 'runAssistant'] };
  context.report.checks.push({ name: '真实前端普通六工厂、共享Job封套和原Job恢复不重新提交', passed: true });
}

async function frontendStreaming(context, current) {
  const { observer, history } = current, signal = AbortSignal.timeout(60000), fixture = context.fixtures['frontend-stream'];
  const definitions = await observer.refreshDefinitions(signal);
  assert.deepEqual(definitions.data, await context.host.client.json('/api/v2/session-definitions'));
  const input = { project_id: fixture.label, prompt }, opened = await observer.open(input, signal);
  const entry = adopt(context, opened.data, { input, transport: 'http', caseId: '前端SDK真实实时工厂', logId: opened.logId });
  const call = await readyCall(context, fixture);
  await release(call, 'start'); await eventsUntil(context, entry, 8);
  await poll(() => observer.readOutput({ limit: 1 }, signal), () => observer.snapshot().stream.events.length === 8, '前端SDK完整快照增量解码');
  const incremental = observer.snapshot();
  assert.deepEqual(incremental.stream.events.map(value => value.event), golden(call.ready.thread_id).slice(0, 8));
  assert.deepEqual(incremental.stream.chunks, entry.chunks);
  assert.equal(incremental.stream.threadId, call.ready.thread_id); assert.equal(incremental.stream.turnCompleted, false);
  const item = incremental.stream.items.find(value => value.item.id === 'item_3');
  assert.ok(item); assert.equal(item.item.text, updated); assert.equal(item.completed, false);
  assert.equal(incremental.stream.text, ''); assert.equal(incremental.result, null);
  await candidate(context, { entry, call });
  await poll(() => observer.readOutput({ limit: 1 }, signal), () => observer.snapshot().stream.events.length === 9, '前端SDK候选未获成功资格');
  await observer.query(signal);
  const candidateSnapshot = observer.snapshot();
  assert.equal(candidateSnapshot.stream.text, answer); assert.equal(candidateSnapshot.stream.turnCompleted, false);
  assert.equal(candidateSnapshot.session.status, 'running'); assert.equal(candidateSnapshot.result, null);
  await release(call, 'release-child'); await release(call, 'release-grandchild'); await release(call, 'exit');
  await finish(context, entry, { fixture, threadId: call.ready.thread_id, turns: 1, success: true });
  await finishCall(context, call, 0);
  const consumed = await observer.pollOutput({ limit: 1 }, signal), expected = expectedResult(fixture.label, call.ready.thread_id, 1);
  assert.deepEqual(consumed.data, expected); assert.deepEqual(observer.snapshot().result, expected);
  assert.deepEqual(observer.snapshot().stream.events.map(value => value.event), golden(call.ready.thread_id));
  assert.deepEqual(observer.snapshot().stream.chunks, entry.chunks);
  const cursor = observer.snapshot().stream.cursor, owner = { project_id: fixture.label, thread_id: call.ready.thread_id };
  await observer.resume(entry.id, owner, signal);
  assert.equal(observer.snapshot().stream.cursor, cursor); assert.deepEqual(observer.snapshot().result, expected);
  const records = await history.refreshRecords(signal);
  assert.ok(records.data.some(value => value.id === entry.id && value.status === 'finished'));
  await history.resume(entry.id, owner, signal);
  assert.equal(history.snapshot().session.status, 'finished'); assert.equal(history.snapshot().stream.cursor, 0);
  assert.equal(history.snapshot().result, null);
  const restored = await history.pollOutput({ limit: 1 }, signal);
  assert.deepEqual(restored.data, expected); assert.deepEqual(history.snapshot().stream.chunks, entry.chunks);
  assert.deepEqual(history.snapshot().stream.events.map(value => value.event), golden(call.ready.thread_id));
  assert.equal(history.snapshot().stream.pendingBytes, 0);
  assert.equal(current.requests.filter(value => value.path === '/api/v2/sessions' && value.method === 'POST').length, 1);
  assert.ok(!current.requests.some(value => value.path.endsWith('/input') || value.path.endsWith('/cancel')));
  publicOnly(observer.snapshot().stream.events);
  context.report.frontend_streaming = { factory: 'createHttpAiSdkStreaming', original_session_id: entry.id,
    original_thread_id: call.ready.thread_id, incremental_events: incremental.stream.events.length,
    same_id_resume_cursor: cursor, restored_result: restored.data, one_open_without_replay: true,
    consumed_chunks: entry.chunks.length, node_typescript_runtime: process.version };
  await writeFile(join(context.directory, 'frontend-consumption.json'), JSON.stringify({ incremental, candidate: candidateSnapshot,
    final: observer.snapshot(), restored: history.snapshot() }, null, 2) + '\n', { flag: 'wx' });
  context.retained.push(entry);
  context.report.checks.push({ name: '真实前端SDK完整快照、候选未成功、Finished、同ID游标与历史恢复', passed: true });
}

export async function frontend(context) {
  const current = await factories(context);
  try { await frontendOrdinary(context, current); await frontendStreaming(context, current); }
  finally { current.ordinary.dispose(); current.observer.dispose(); current.history.dispose(); }
  context.report.frontend_requests = current.requests;
}
