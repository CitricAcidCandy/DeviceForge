import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;

export async function poll(read, predicate, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(25);
  }
  throw new Error(`设备提供者等待超时：${label}`);
}

// 只处理公开 HTTP/MCP 与共享任务，不导入宿主内部实现。
export function createClient(base, report) {
  let requestId = 0;
  const logIds = new Set();
  const call = async (path, options = {}) => {
    const before = performance.now();
    const pending = { path, method: options.method ?? 'GET', started_at: new Date().toISOString() };
    report.last_request = pending;
    let response;
    let body;
    try {
      response = await fetch(`${base}${path}`, { headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(20000), ...options });
      body = await response.json();
    } catch (error) {
      // 不记录请求体、访问凭据或任意插件输出；关闭请求不能覆盖原始失败请求。
      report.failed_request ??= { ...pending, status: response?.status,
        log_id: response?.headers.get('x-deviceforge-log-id'), elapsed_ms: performance.now() - before,
        error_name: error.name, error_code: error.code };
      throw error;
    }
    const logId = response.headers.get('x-deviceforge-log-id');
    report.last_request = { path, method: options.method ?? 'GET', status: response.status,
      code: body.error?.code, log_id: logId, elapsed_ms: performance.now() - before };
    assert.match(logId, uuid, '响应必须包含服务端日志 ID');
    if (path.startsWith('/api/v2/')) assert.equal(body.log_id, logId);
    logIds.add(logId);
    return { status: response.status, body, logId };
  };
  const json = async (path, { status = 200, code, ...options } = {}) => {
    const reply = await call(path, options);
    assert.equal(reply.status, status, `${options.method ?? 'GET'} ${path}`);
    if (code) assert.equal(reply.body.error?.code, code, path);
    else { assert.equal(reply.body.error, undefined); assert.ok(Object.hasOwn(reply.body, 'data')); }
    return code ? reply.body.error : reply.body.data;
  };
  const post = (path, input, options = {}) => json(path, { method: 'POST',
    ...(input !== undefined ? { body: JSON.stringify(input) } : {}), ...options });
  const rpc = async (method, params) => {
    const id = ++requestId;
    const reply = await call('/mcp', { method: 'POST', headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream', origin: base },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
    assert.equal(reply.status, 200);
    assert.equal(reply.body.id, id);
    assert.equal(reply.body.error, undefined, '业务错误应在工具结果中表达');
    assert.equal(reply.body.result._meta['deviceforge/log_id'], reply.logId);
    return reply.body.result;
  };
  const tool = async (name, input = {}, code) => {
    const result = await rpc('tools/call', { name, arguments: input });
    assert.equal(result.isError, Boolean(code), name);
    if (code) assert.equal(result.structuredContent.code, code, name);
    return result.structuredContent;
  };
  const tools = async () => {
    const all = [];
    let cursor;
    do {
      const result = await rpc('tools/list', cursor ? { cursor } : {});
      all.push(...result.tools.map((item) => item.name));
      assert.ok(all.length <= 4200, 'MCP 工具分页必须有界');
      if (result.nextCursor) assert.notEqual(result.nextCursor, cursor);
      cursor = result.nextCursor;
    } while (cursor);
    return all;
  };
  const job = (id) => json(`/api/v2/jobs/${id}`);
  const finished = async (id, status = 'succeeded') => {
    const value = await poll(() => job(id), (item) => ['succeeded', 'failed', 'cancelled'].includes(item.status), `任务 ${id}`);
    assert.equal(value.status, status, `共享任务终态 ${id}`);
    assert.equal((await tool('deviceforge.get_job', { id })).status, status);
    return value;
  };
  const action = (input, transport = 'http') => transport === 'http'
    ? post('/api/v2/device-actions', input, { status: 202 }) : tool('deviceforge.invoke_device', input);
  const refresh = (provider, options) => post(`/api/v2/device-providers/${provider.id}/refresh`,
    { generation: provider.generation }, options);
  const manage = (id, action_, transport = 'http') => transport === 'http'
    ? post(`/api/v2/plugins/${id}/${action_}`) : tool(`deviceforge.${action_}_plugin`, { id });
  return { base, call, json, post, tool, tools, job, finished, action, refresh, manage, logIds };
}
