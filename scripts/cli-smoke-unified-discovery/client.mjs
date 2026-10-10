import assert from 'node:assert/strict';
import { poll } from '../device-provider/client.mjs';

const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;

// HTTP和独立MCP监听器共用公开日志校验；令牌只留在私有headers，不返回或落盘。
export function clientFor({ base, mcp, headers, evidence }) {
  let requestId = 8500;
  const logIds = new Set();
  const common = new Headers(headers);
  common.set('content-type', 'application/json');
  const diagnostic = {};
  async function send(url, options) {
    const summary = { method: options.method ?? 'GET', path: new URL(url).pathname };
    diagnostic.lastRequest = summary;
    let response;
    try { response = await fetch(url, { signal: AbortSignal.timeout(20000), ...options }); }
    catch (error) {
      diagnostic.failedRequest ??= { ...summary, errorName: error.name };
      throw error;
    }
    const logId = response.headers.get('x-deviceforge-log-id');
    assert.match(logId, uuid, '必须有真实服务端日志ID');
    logIds.add(logId);
    const body = await response.json();
    diagnostic.lastRequest = { ...summary, status: response.status, logId, code: body.error?.code };
    return { response, body, logId };
  }
  async function json(path, { status = 200, code, ...options } = {}) {
    const reply = await send(`${base}${path}`, { headers: common, ...options });
    assert.equal(reply.response.status, status, path);
    assert.equal(reply.body.log_id, reply.logId);
    if (code) {
      assert.equal(reply.body.error?.code, code, path);
      evidence.rejections.push({ path, transport: 'http', status, code, logId: reply.logId });
      return reply.body.error;
    }
    assert.equal(reply.body.error, undefined);
    assert.ok(Object.hasOwn(reply.body, 'data'));
    return reply.body.data;
  }
  const post = (path, input, options = {}) => json(path, { method: 'POST',
    ...(input !== undefined ? { body: JSON.stringify(input) } : {}), ...options });
  async function rpc(method, params) {
    const id = ++requestId;
    const rpcHeaders = new Headers(common);
    rpcHeaders.set('accept', 'application/json, text/event-stream');
    rpcHeaders.set('origin', base);
    const reply = await send(mcp, { method: 'POST', headers: rpcHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
    assert.equal(reply.response.status, 200);
    assert.equal(reply.body.id, id);
    assert.equal(reply.body.error, undefined, '业务失败必须由工具错误表达');
    assert.equal(reply.body.result._meta['deviceforge/log_id'], reply.logId);
    return { result: reply.body.result, logId: reply.logId };
  }
  async function tool(name, input = {}, code) {
    const { result, logId } = await rpc('tools/call', { name, arguments: input });
    assert.equal(result.isError, Boolean(code), name);
    if (code) {
      assert.equal(result.structuredContent.code, code, name);
      evidence.rejections.push({ tool: name, transport: 'mcp', status: 200, code, logId });
    }
    return result.structuredContent;
  }
  async function tools() {
    const names = [];
    const cursors = new Set();
    let cursor;
    do {
      const { result } = await rpc('tools/list', cursor ? { cursor } : {});
      names.push(...result.tools.map((item) => item.name));
      assert.ok(names.length <= 4200, 'MCP工具枚举必须有界');
      cursor = result.nextCursor;
      if (cursor) {
        assert.ok(!cursors.has(cursor), '分页游标不能循环');
        cursors.add(cursor);
      }
    } while (cursor);
    return names;
  }
  const job = (id) => json(`/api/v2/jobs/${id}`);
  async function finished(id, status = 'succeeded') {
    const result = await poll(() => job(id), (value) => ['succeeded', 'failed', 'cancelled'].includes(value.status), `npx任务 ${id}`);
    assert.equal(result.status, status);
    assert.deepEqual(await tool('deviceforge.get_job', { id }), result);
    return result;
  }
  const refresh = (provider, options = {}) => post(`/api/v2/device-providers/${provider.id}/refresh`,
    { generation: provider.generation }, options);
  const manage = (id, action, transport = 'http') => transport === 'http'
    ? post(`/api/v2/plugins/${id}/${action}`) : tool(`deviceforge.${action}_plugin`, { id });
  return { json, post, tool, tools, job, finished, refresh, manage, logIds, diagnostic };
}
