// 只发送公开 HTTP/MCP 请求；缺接口和缺工具直接阻断，不提供成功降级。
import assert from 'node:assert/strict';
import { assertView, digest, poll, save } from './evidence.mjs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const protocol = '2025-11-25';
export const tools = {
  get: 'deviceforge.get_plugin_dependencies',
  scan: 'dependency.scan',
  install: 'dependency.install',
};
export const targetPath = (target) => `/api/v2/plugin-dependencies/${target.kind}/${encodeURIComponent(target.id)}`;

export function client(base, directory, report, signal) {
  let sequence = 0, rpcId = 0;
  async function raw(path, { method = 'GET', input, bytes, status = 200, contentType = 'application/json', headers = {} } = {}) {
    const number = ++sequence;
    const record = { number, base, method, path, started_at: new Date().toISOString(),
      ...(bytes === undefined ? {} : { upload: { size: bytes.length, sha256: digest(bytes) } }) };
    report.requests.push(record);
    try {
      const response = await fetch(base + path, {
        method, headers: { 'content-type': contentType, accept: 'application/json, text/event-stream', origin: base, ...headers },
        body: bytes ?? (input === undefined ? undefined : JSON.stringify(input)),
        signal: signal && path !== '/api/v2/system/shutdown'
          ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
      });
      record.status = response.status;
      record.log_id = response.headers.get('x-deviceforge-log-id');
      const text = await response.text();
      record.finished_at = new Date().toISOString();
      const file = join(directory, `http-${String(number).padStart(5, '0')}.json`);
      record.evidence = file;
      await save(file, { request: { method, path, content_type: contentType,
        ...(input === undefined ? {} : { input }), ...(record.upload ? { upload: record.upload } : {}),
        ...(headers['x-deviceforge-plugin-release'] ? { release: headers['x-deviceforge-plugin-release'] } : {}) },
      status: response.status, log_id: record.log_id, body: text });
      if (response.status === 404 && (path.startsWith('/api/v2/plugin-dependencies/') || path === '/mcp')) {
        throw new Error(`冻结宿主尚未实现目标接口：${method} ${path}；原响应已保留`);
      }
      assert.match(record.log_id ?? '', uuid, '公开响应必须包含日志 ID');
      let body;
      try { body = JSON.parse(text); } catch { throw new Error(`响应不是 JSON：${method} ${path}`); }
      if (path.startsWith('/api/v2/')) assert.equal(body.log_id, record.log_id);
      assert.equal(response.status, status, `${method} ${path}：${JSON.stringify(body.error ?? body)}`);
      return { body, logId: record.log_id };
    } catch (error) { record.error = error.message; throw error; }
  }
  async function http(path, options) {
    const { body } = await raw(path, options);
    assert.ok(Object.hasOwn(body, 'data') || Object.hasOwn(body, 'error'), 'HTTP 响应缺少公开信封');
    return Object.hasOwn(body, 'data') ? body.data : body.error;
  }
  async function rpc(method, params = {}) {
    const id = ++rpcId;
    const { body, logId } = await raw('/mcp', { method: 'POST',
      headers: { 'MCP-Protocol-Version': protocol, 'Mcp-Method': method, ...(params.name ? { 'Mcp-Name': params.name } : {}) },
      input: { jsonrpc: '2.0', id, method, params: { ...params, _meta: {
        'io.modelcontextprotocol/protocolVersion': protocol,
        'io.modelcontextprotocol/clientInfo': { name: 'plugin-dependencies-smoke', version: '1' },
        'io.modelcontextprotocol/clientCapabilities': {},
      } } } });
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.id, id);
    assert.equal(body.error, undefined, JSON.stringify(body.error));
    assert.equal(body.result?._meta?.['deviceforge/log_id'], logId);
    return body.result;
  }
  async function tool(name, args, errorCode) {
    const value = await rpc('tools/call', { name, arguments: args });
    assert.equal(value.isError, Boolean(errorCode), JSON.stringify(value.structuredContent));
    if (errorCode) assert.equal(value.structuredContent?.code, errorCode);
    return value.structuredContent;
  }
  async function requireTools() {
    const initialized = await rpc('initialize', { protocolVersion: protocol, capabilities: {},
      clientInfo: { name: 'plugin-dependencies-smoke', version: '1' } });
    assert.equal(initialized.protocolVersion, protocol, '初始化必须协商当前宿主 MCP 协议');
    report.mcp_protocol = initialized.protocolVersion;
    const all = [], cursors = new Set();
    let cursor;
    do {
      const result = await rpc('tools/list', cursor ? { cursor } : {});
      assert.ok(Array.isArray(result.tools)); all.push(...result.tools);
      cursor = result.nextCursor;
      assert.ok(all.length <= 5000 && (!cursor || !cursors.has(cursor)), 'MCP 分页未推进或数量超限');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    for (const name of Object.values(tools)) assert.ok(all.some((item) => item.name === name), `冻结宿主尚未实现 MCP 工具：${name}`);
    report.mcp_tools = all.filter((item) => Object.values(tools).includes(item.name));
  }
  async function view(target, transport = 'http', canonicalTarget = target) {
    if (!isDeepStrictEqual(canonicalTarget, target)) {
      assert.ok(['server', 'browser'].includes(target.kind) && canonicalTarget.kind === 'release',
        '只有声明属于发布的组件允许规范化为明确的 release 目标');
    }
    return assertView(transport === 'http' ? await http(targetPath(target))
      : await tool(tools.get, { target }), canonicalTarget);
  }
  async function finish(submitted, expected = 'succeeded') {
    assert.match(submitted.id ?? '', uuid, '修改接口必须返回真实 Job');
    const final = await poll(() => http(`/api/v2/jobs/${submitted.id}`),
      (value) => ['succeeded', 'failed', 'cancelled'].includes(value.status), '依赖 Job 终态',
      submitted.operation.startsWith('installation.') ? 300000 : 120000);
    assert.equal(final.id, submitted.id, '轮询结果必须属于本次任务');
    assert.equal(final.operation, submitted.operation, '终态不能串到另一操作');
    const mcp = await tool('deviceforge.get_job', { id: submitted.id });
    assert.deepEqual(mcp, final, 'HTTP/MCP 必须读取同一终态 Job');
    const events = await http(`/api/v2/jobs/${submitted.id}/events`);
    const terminal = events.filter((event) => ['succeeded', 'failed', 'cancelled'].includes(event.status));
    assert.equal(terminal.length, 1, 'Job 必须只有一个终态事件');
    assert.equal(terminal[0].status, final.status);
    report.jobs.push({ id: final.id, operation: final.operation, status: final.status, error: final.error, events: events.length });
    assert.equal(final.status, expected, final.error ?? JSON.stringify(final.result));
    return final;
  }
  async function change(target, action, { transport = 'http', ids, expected = 'succeeded', revision, canonicalTarget = target } = {}) {
    assert.ok(['scan', 'install'].includes(action));
    const current = await view(target, 'http', canonicalTarget);
    const input = { expected_revision: revision ?? current.revision, ...(ids === undefined ? {} : { dependency_ids: ids }) };
    const submitted = transport === 'http'
      ? await http(`${targetPath(current.target)}/${action}`, { method: 'POST', input, status: 202 })
      : await tool(tools[action], { target: current.target, ...input });
    const job = await finish(submitted, expected);
    if (expected === 'succeeded') assertView(job.result, current.target);
    return { job, view: await view(current.target) };
  }
  return { raw, http, rpc, tool, view, change, finish, requireTools };
}
