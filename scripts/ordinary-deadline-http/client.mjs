import assert from 'node:assert/strict';
import { createClient } from '../device-provider/client.mjs';

// 每次公开请求独立保存诊断，避免两项长任务并行时覆盖首次失败。
export function clientFor(base, report, { mcp } = {}) {
  const mcpBase = mcp ? new URL(mcp) : new URL('/mcp', base);
  assert.equal(mcpBase.pathname, '/mcp');
  assert.ok(!mcpBase.username && !mcpBase.password && !mcpBase.search && !mcpBase.hash);
  const logIds = new Set();
  const requests = report.requests ??= [];
  const invoke = async (name, args, context = {}) => {
    const local = {};
    const endpoint = ['tool', 'tools'].includes(name) ? mcpBase.origin : base;
    const client = createClient(endpoint, local);
    const pending = { client_method: name, started_at: new Date().toISOString(), ...context,
      ...(['json', 'post', 'call'].includes(name) ? { path: args[0] } : {}),
      ...(['tool', 'tools'].includes(name) ? { path: '/mcp', tool: name === 'tool' ? args[0] : undefined } : {}),
      ...(name === 'job' ? { path: `/api/v2/jobs/${args[0]}` } : {}) };
    report.in_flight_requests ??= [];
    report.in_flight_requests.push(pending);
    try {
      const value = await client[name](...args);
      requests.push({ ...pending, ...local.last_request, outcome: 'returned' });
      return value;
    } catch (error) {
      const failed = { ...pending, ...(local.failed_request ?? local.last_request), outcome: 'threw' };
      report.failed_request ??= failed;
      requests.push(failed);
      throw error;
    } finally {
      for (const id of client.logIds) logIds.add(id);
      report.in_flight_requests = report.in_flight_requests.filter((entry) => entry !== pending);
      if (local.last_request) report.last_request = { ...pending, ...local.last_request };
    }
  };
  const scoped = (context) => ({
    json: (...args) => invoke('json', args, context),
    post: (...args) => invoke('post', args, context),
    tool: (...args) => invoke('tool', args, context),
    job: (...args) => invoke('job', args, context),
  });
  return { base, mcp: mcpBase.href, logIds, scope: scoped,
    ...scoped({}), call: (...args) => invoke('call', args), tools: () => invoke('tools', []) };
}

export async function sharedJob(client, entry) {
  const observed = client.scope({ case_id: entry.case_id, job_id: entry.job_id, phase: 'history' });
  const http = await observed.job(entry.job_id);
  const mcp = await observed.tool('deviceforge.get_job', { id: entry.job_id });
  assert.deepEqual(mcp, http, 'HTTP/MCP 必须读取同一 Job 原文');
  assert.equal(http.id, entry.job_id);
  assert.equal(http.operation, entry.operation);
  assert.deepEqual(http.input, entry.input);
  return http;
}

export async function jobEvents(client, entry) {
  const observed = client.scope({ case_id: entry.case_id, job_id: entry.job_id, phase: 'events' });
  const events = await observed.json(`/api/v2/jobs/${entry.job_id}/events`);
  const mcp = await observed.tool('deviceforge.job_events', { id: entry.job_id, after: 0 });
  assert.deepEqual(mcp, events, 'HTTP/MCP 必须读取同一份 Job 事件历史');
  assert.ok(Array.isArray(events));
  assert.ok(events.every((event) => event.job_id === entry.job_id));
  const terminals = events.filter((event) => ['succeeded', 'failed', 'cancelled'].includes(event.status));
  assert.equal(terminals.length, 1, '同次 Job 只允许一个终态事件');
  assert.equal(terminals[0].status, entry.expected_status);
  return events.map(({ sequence, status }) => ({ sequence, status }));
}
