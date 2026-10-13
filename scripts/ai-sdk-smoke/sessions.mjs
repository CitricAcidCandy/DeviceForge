import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { poll } from '../device-provider/client.mjs';
import { expectedResult, golden, operation, pluginId, prompt, publicOnly } from './contracts.mjs';

export async function open(context, fixture, { transport = 'http', threadId, caseId = fixture.label } = {}) {
  const input = { project_id: fixture.label, prompt, ...(threadId ? { thread_id: threadId } : {}) };
  const client = context.host.client.scope({ case_id: caseId, phase: 'open' });
  const info = transport === 'http' ? await client.post('/api/v2/sessions', { operation, input }, { status: 202 })
    : await client.tool(operation, input);
  return adopt(context, info, { input, transport, caseId, logId: context.report.last_request.log_id });
}

export function adopt(context, info, { input, transport, caseId, logId }) {
  assert.equal(info.operation, operation); assert.equal(info.plugin_id, pluginId);
  assert.equal(info.generation, context.generation); assert.equal(info.status, 'opening');
  const entry = { id: info.id, input, transport, case_id: caseId, operation, plugin_id: pluginId,
    generation: info.generation, log_id: logId, chunks: [], events: [], cursor: 0, pending: Buffer.alloc(0) };
  context.report.opened.push(entry); return entry;
}

export async function page(context, entry, transport = entry.transport, limit = 1) {
  const client = context.host.client.scope({ case_id: entry.case_id, phase: 'output' });
  const value = transport === 'http' ? await client.json(`/api/v2/sessions/${entry.id}/output?after=${entry.cursor}&limit=${limit}`)
    : await client.tool('deviceforge.session_output', { id: entry.id, after: entry.cursor, limit });
  assert.equal(value.session.id, entry.id); assert.equal(value.session.generation, entry.generation);
  assert.ok(value.chunks.length <= limit);
  for (const chunk of value.chunks) {
    assert.ok(chunk.sequence > entry.cursor); assert.equal(chunk.stream, 'stdout');
    assert.ok(chunk.bytes.length > 0 && chunk.bytes.length <= 8192);
    assert.ok(chunk.bytes.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255));
    entry.cursor = chunk.sequence; entry.chunks.push(chunk);
    entry.pending = Buffer.concat([entry.pending, Buffer.from(chunk.bytes)]);
    assert.ok(entry.pending.length <= 512 * 1024);
    let newline;
    while ((newline = entry.pending.indexOf(10)) >= 0) {
      const bytes = entry.pending.subarray(0, newline); entry.pending = entry.pending.subarray(newline + 1);
      const event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      publicOnly(event); entry.events.push(event);
    }
  }
  assert.equal(value.next_sequence, entry.cursor); return value;
}

export async function running(context, entry) {
  const info = await context.host.client.json(`/api/v2/sessions/${entry.id}`);
  assert.equal(info.status, 'running'); assert.equal(info.completion, null);
  assert.deepEqual(await context.host.client.tool('deviceforge.get_session', { id: entry.id }), info);
  return info;
}

export async function eventsUntil(context, entry, count) {
  await poll(async () => { const value = await page(context, entry);
    if (entry.events.length < count) assert.notEqual(value.session.status, 'finished'); return value;
  }, () => entry.events.length >= count, 'SDK公开事件数量');
  assert.equal(entry.events.length, count);
}

export async function finish(context, entry, { fixture, threadId, turns, success = false } = {}) {
  const info = await poll(() => context.host.client.json(`/api/v2/sessions/${entry.id}`), value => value.status === 'finished', 'SDK公共Closed/Finished');
  assert.equal(info.completion.cleanup, 'complete'); assert.equal(info.completion.process_exited, true);
  assert.deepEqual(await context.host.client.tool('deviceforge.get_session', { id: entry.id }), info);
  await poll(() => page(context, entry, entry.transport === 'http' ? 'mcp' : 'http'), value => value.chunks.length === 0, 'SDK终态输出排空');
  assert.equal(entry.pending.length, 0); assert.equal(entry.cursor, info.output_sequence);
  const outcome = info.completion.outcome; assert.ok(outcome); assert.deepEqual(outcome.artifacts, []); publicOnly(outcome);
  if (success) {
    assert.equal(info.completion.failure, null); assert.equal(outcome.error, null);
    assert.deepEqual(outcome.result, expectedResult(fixture.label, threadId, turns));
    assert.deepEqual(entry.events, golden(threadId));
    assert.ok(entry.chunks.some(chunk => chunk.bytes.length === 8192));
  } else {
    assert.equal(outcome.result, null); assert.equal(typeof outcome.error, 'string');
    assert.ok(!entry.events.some(event => event.type === 'turn.completed'), '失败或取消不能发送公开成功事件');
  }
  entry.history = { session: info, chunks: entry.chunks }; entry.completion = info.completion;
  await writeFile(join(context.directory, entry.id + '.output.json'), JSON.stringify({ chunks: entry.chunks, events: entry.events }), { flag: 'wx' });
  context.report.checks.push({ name: entry.case_id, passed: true }); return info;
}

export async function preserve(context, entry, phase) {
  assert.deepEqual(await context.host.client.json(`/api/v2/sessions/${entry.id}`), entry.history.session);
  let after = 0; const chunks = [];
  await poll(async () => { const value = await context.host.client.tool('deviceforge.session_output', { id: entry.id, after, limit: 1 });
    chunks.push(...value.chunks); after = value.next_sequence; return value;
  }, value => value.chunks.length === 0, 'SDK旧会话历史分页');
  assert.deepEqual(chunks, entry.history.chunks); context.report.history_phases.push({ phase, id: entry.id, chunks: chunks.length });
}

export async function submit(context, name, input, transport = 'http') {
  const operationId = 'plugin.ai-sdk.' + name;
  const client = context.host.client.scope({ case_id: name, phase: 'submit' });
  const ticket = transport === 'http' ? await client.post('/api/v2/jobs', { operation: operationId, input }, { status: 202 })
    : await client.tool(operationId, input);
  const entry = { id: ticket.id, operation: operationId, input, log_id: context.report.last_request.log_id, expected_status: 'succeeded' };
  context.report.jobs.push(entry); return entry;
}

export async function jobResult(context, entry) {
  const job = await poll(() => context.host.client.job(entry.id), value => ['succeeded', 'failed', 'cancelled'].includes(value.status), 'SDK普通任务终态');
  assert.equal(job.status, entry.expected_status); assert.equal(job.error, null);
  assert.deepEqual(await context.host.client.tool('deviceforge.get_job', { id: entry.id }), job);
  assert.deepEqual(job.result.artifacts, []); publicOnly(job.result); entry.history = job; return job.result.result;
}
