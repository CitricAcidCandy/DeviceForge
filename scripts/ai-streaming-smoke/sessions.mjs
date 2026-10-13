import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { poll } from '../device-provider/client.mjs';
import { expectedResult, golden, operation, prompt, publicOnly } from './contracts.mjs';

export async function open(context, fixture, { transport = 'http', threadId, input, caseId = fixture.label } = {}) {
  context.report.active_case_id = caseId;
  const body = input ?? { project_id: fixture.label, prompt, ...(threadId ? { thread_id: threadId } : {}) };
  const client = context.host.client.scope({ case_id: caseId, phase: 'open' });
  const info = transport === 'http'
    ? await client.post('/api/v2/sessions', { operation, input: body }, { status: 202 })
    : await client.tool(operation, body);
  return adopt(context, info, { body, transport, caseId, logId: context.report.last_request.log_id });
}

export function adopt(context, info, { body, transport, caseId, logId }) {
  assert.match(info.id, /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/);
  assert.equal(info.status, 'opening');
  assert.equal(info.operation, operation);
  assert.equal(info.plugin_id, 'ai-assistant');
  assert.equal(info.generation, context.generation);
  const entry = { case_id: caseId, id: info.id, transport, plugin_id: info.plugin_id,
    generation: info.generation, operation, log_id: logId,
    input: body, chunks: [], cursor: 0, events: [], pending: Buffer.alloc(0) };
  context.report.opened.push(entry);
  return entry;
}

export async function page(context, entry, transport = entry.transport, limit = 1) {
  const client = context.host.client.scope({ case_id: entry.case_id, phase: 'output' });
  const value = transport === 'http'
    ? await client.json(`/api/v2/sessions/${entry.id}/output?after=${entry.cursor}&limit=${limit}`)
    : await client.tool('deviceforge.session_output', { id: entry.id, after: entry.cursor, limit });
  assert.equal(value.session.id, entry.id);
  assert.equal(value.session.generation, entry.generation);
  assert.ok(value.chunks.length <= limit);
  for (const chunk of value.chunks) {
    assert.ok(chunk.sequence > entry.cursor);
    assert.equal(chunk.stream, 'stdout');
    assert.ok(chunk.bytes.length > 0 && chunk.bytes.length <= 8192);
    assert.ok(chunk.bytes.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255));
    entry.chunks.push(chunk);
    entry.cursor = chunk.sequence;
    entry.pending = Buffer.concat([entry.pending, Buffer.from(chunk.bytes)]);
    assert.ok(entry.pending.length <= 512 * 1024);
    let newline;
    while ((newline = entry.pending.indexOf(10)) >= 0) {
      const raw = entry.pending.subarray(0, newline);
      entry.pending = entry.pending.subarray(newline + 1);
      const event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
      publicOnly(event);
      entry.events.push(event);
    }
  }
  assert.equal(value.next_sequence, entry.cursor);
  return value;
}

export async function untilEvent(context, entry, kind) {
  return poll(async () => {
    const value = await page(context, entry);
    if (!entry.events.some(event => event.type === kind)) assert.notEqual(value.session.status, 'finished', '目标增量事件前不能结束');
    return value;
  }, () => entry.events.some(event => event.type === kind), 'AI规范增量事件 ' + kind);
}

export async function running(context, entry) {
  const info = await context.host.client.json(`/api/v2/sessions/${entry.id}`);
  assert.equal(info.status, 'running');
  assert.equal(info.completion, null);
  assert.deepEqual(await context.host.client.tool('deviceforge.get_session', { id: entry.id }), info);
  return info;
}

export async function finish(context, entry, { fixture, turns, error, success = false } = {}) {
  const info = await poll(() => context.host.client.json(`/api/v2/sessions/${entry.id}`),
    value => value.status === 'finished', 'AI公共Finished', 12000);
  assert.equal(info.completion.cleanup, 'complete');
  assert.equal(info.completion.process_exited, true);
  assert.deepEqual(await context.host.client.tool('deviceforge.get_session', { id: entry.id }), info);
  await poll(async () => page(context, entry, entry.transport === 'http' ? 'mcp' : 'http'),
    value => value.chunks.length === 0, '消费全部终态留存输出');
  assert.equal(entry.pending.length, 0);
  assert.equal(entry.cursor, info.output_sequence);
  const outcome = info.completion.outcome;
  assert.ok(outcome);
  assert.deepEqual(outcome.artifacts, []);
  publicOnly(outcome);
  if (success) {
    assert.equal(info.completion.failure, null);
    assert.equal(outcome.error, null);
    assert.deepEqual(outcome.result, expectedResult(fixture.label, fixture.threadId, turns));
    assert.deepEqual(entry.events, golden(fixture.threadId));
    assert.notEqual(entry.id, outcome.result.thread_id);
    assert.ok(entry.chunks.some(chunk => chunk.bytes.length === 8192), '大正文必须真实分块');
  } else {
    assert.equal(outcome.result, null);
    assert.equal(typeof outcome.error, 'string');
    if (error) assert.match(outcome.error, error);
  }
  const outputFile = join(context.directory, entry.id + '.output.json');
  await writeFile(outputFile, JSON.stringify({ chunks: entry.chunks, events: entry.events }), { flag: 'wx' });
  entry.history = { session: info, chunks: entry.chunks };
  entry.completion = info.completion;
  context.report.checks.push({ name: entry.case_id, passed: true });
  return info;
}

export async function remove(context, entry) {
  assert.ok(entry.history);
  const removed = await context.host.client.tool('deviceforge.remove_session', { id: entry.id });
  assert.deepEqual(removed, { id: entry.id });
  entry.removed = true;
}

export async function management(context, fixture, action, expected) {
  const input = { project_id: fixture.label, thread_id: fixture.threadId };
  const client = context.host.client.scope({ case_id: fixture.label, phase: 'thread-' + action });
  const operationId = 'plugin.ai-assistant.session.' + action;
  const submitted = await client.tool(operationId, input);
  const entry = { id: submitted.id, operation: operationId, input,
    log_id: context.report.last_request.log_id, expected_status: 'succeeded' };
  context.report.jobs.push(entry);
  const job = await poll(() => client.job(entry.id), value => ['succeeded', 'failed', 'cancelled'].includes(value.status), '持久AI线程管理');
  entry.history = job;
  assert.equal(job.status, 'succeeded');
  assert.equal(job.error, null);
  assert.deepEqual(job.result, { result: { project_id: fixture.label, thread_id: fixture.threadId, ...expected }, artifacts: [] });
  assert.deepEqual(await client.tool('deviceforge.get_job', { id: entry.id }), job);
  return job.result.result;
}

export async function preserve(context, entry, phase) {
  assert.deepEqual(await context.host.client.json(`/api/v2/sessions/${entry.id}`), entry.history.session);
  let after = 0;
  const chunks = [];
  await poll(async () => {
    const value = await context.host.client.tool('deviceforge.session_output', { id: entry.id, after, limit: 1 });
    chunks.push(...value.chunks);
    after = value.next_sequence;
    return value;
  }, value => value.chunks.length === 0, '旧会话历史完整分页');
  assert.deepEqual(chunks, entry.history.chunks);
  context.report.history_phases.push({ phase, id: entry.id, chunks: chunks.length });
}
