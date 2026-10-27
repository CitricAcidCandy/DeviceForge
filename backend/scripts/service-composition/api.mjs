import assert from 'node:assert/strict';
import { poll, terminal } from './common.mjs';

const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

export function createApi(base, token, report, signal) {
  let sequence = 0;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  async function call(path, options = {}) {
    signal?.throwIfAborted();
    const response = await fetch(`${base}${path}`, { headers, ...options,
      signal: AbortSignal.any([AbortSignal.timeout(options.timeout ?? 8000), ...(signal ? [signal] : [])]) });
    const body = await response.json();
    const logId = response.headers.get('x-deviceforge-log-id');
    assert.match(logId, uuid, 'HTTP 响应必须包含日志关联');
    if (path.startsWith('/api/v2/')) assert.equal(body.log_id, logId);
    assert.ok(report.requests.length < 6000, '请求记录不得无限增长');
    report.requests.push({ path, method: options.method ?? 'GET', status: response.status,
      log_id: logId, code: body.error?.code });
    return { status: response.status, data: body.data, body, logId };
  }
  async function tool(name, arguments_ = {}, errorCode) {
    const id = ++sequence;
    const reply = await call('/mcp', { method: 'POST',
      headers: { ...headers, accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: arguments_ } }) });
    assert.equal(reply.status, 200, `${name}：${reply.body.error?.message ?? 'MCP 传输状态异常'}`);
    assert.equal(reply.body.id, id);
    assert.equal(reply.body.error, undefined, '业务错误不得伪装成 JSON-RPC 协议错误');
    const result = reply.body.result;
    assert.equal(result._meta['deviceforge/log_id'], reply.logId);
    assert.equal(result.isError, Boolean(errorCode));
    if (errorCode) assert.equal(result.structuredContent.code, errorCode);
    return result.structuredContent;
  }
  async function get(path) {
    const reply = await call(path);
    assert.equal(reply.status, 200);
    return reply.data;
  }
  async function post(path, body, status = 200) {
    const reply = await call(path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(reply.status, status, `${path}：${reply.body.error?.code ?? '响应状态异常'}`);
    return reply.data;
  }
  const job = (id) => get(`/api/v2/jobs/${id}`);
  async function finished(id) {
    const result = await poll(() => job(id), terminal, `任务 ${id} 结束`);
    assert.deepEqual(await tool('deviceforge.get_job', { id }), result, 'HTTP/MCP 必须读取同一个 Job');
    const events = await get(`/api/v2/jobs/${id}/events`);
    assert.deepEqual(await tool('deviceforge.job_events', { id }), events);
    assert.equal(events.filter((event) => terminal(event)).length, 1, '同一 Job 只能有一个终态事件');
    report.jobs.push({ id, operation: result.operation, status: result.status, error: result.error, events });
    return result;
  }
  async function catalog() {
    const result = await get('/api/v2/services');
    assert.deepEqual(await tool('deviceforge.list_services'), result, 'HTTP/MCP 服务快照必须一致');
    return result;
  }
  async function service(id, input, transport = 'http', extra = {}) {
    const request = { version: '1.0', input, ...extra };
    const result = transport === 'http'
      ? await post(`/api/v2/services/${id}/calls`, request, 202)
      : await tool('deviceforge.call_service', { id, ...request });
    assert.match(result.id, uuid);
    report.submissions.push({ id: result.id, operation: result.operation, transport });
    return result;
  }
  async function operation(id, input = {}, transport = 'http') {
    const result = transport === 'http'
      ? await post('/api/v2/jobs', { operation: id, input }, 202) : await tool(id, input);
    report.submissions.push({ id: result.id, operation: id, transport });
    return result;
  }
  async function manage(id, action, transport = 'http') {
    const result = transport === 'http'
      ? await post(`/api/v2/plugins/${id}/${action}`)
      : await tool(`deviceforge.${action}_plugin`, { id });
    assert.equal(result.state, action === 'load' ? 'loaded' : 'unloaded');
    assert.equal(result.cleanup_failed, false, '正常示例必须明确确认清理');
    return result;
  }
  async function rejectService(id, input, status, code, extra = {}) {
    const before = await get('/api/v2/jobs?limit=200');
    const request = { version: '1.0', input, ...extra };
    const reply = await call(`/api/v2/services/${id}/calls`, { method: 'POST', body: JSON.stringify(request) });
    assert.equal(reply.status, status);
    assert.equal(reply.body.error.code, code);
    await tool('deviceforge.call_service', { id, ...request }, code);
    assert.deepEqual(await get('/api/v2/jobs?limit=200'), before, '准入拒绝不得新增 Job');
  }
  async function rejectOperation(id, input, status, code) {
    const before = await get('/api/v2/jobs?limit=200');
    const reply = await call('/api/v2/jobs', { method: 'POST', body: JSON.stringify({ operation: id, input }) });
    assert.equal(reply.status, status);
    assert.equal(reply.body.error.code, code);
    await tool(id, input, code);
    assert.deepEqual(await get('/api/v2/jobs?limit=200'), before, '入口拒绝不得新增 Job');
  }
  return { call, tool, get, post, job, finished, catalog, service, operation, manage, rejectService, rejectOperation };
}
