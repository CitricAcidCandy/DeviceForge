import assert from 'node:assert/strict';
import { createClient, poll } from '../device-provider/client.mjs';
import { sha256 } from '../../backend/scripts/online-plugins/fixtures.mjs';

const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;

// 复用公开 JSON/MCP 客户端；只补二进制下载与失败请求冻结，不保存正文。
export function clientFor(base, report, { mcp } = {}) {
  const existing = createClient(base, report);
  let toolsClient = existing;
  if (mcp) {
    const endpoint = new URL(mcp);
    assert.ok(['http:', 'https:'].includes(endpoint.protocol));
    assert.equal(endpoint.pathname, '/mcp', '独立 MCP URL 使用公开 /mcp 端点');
    assert.ok(!endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash);
    toolsClient = createClient(endpoint.origin, report);
    report.mcp_endpoint = endpoint.href;
  }
  // 既有 action/manage 内部捕获了原 tool，需要一并覆盖 MCP 分支，HTTP 仍完全复用。
  const overrides = { tool: toolsClient.tool, tools: toolsClient.tools,
    action: (input, transport = 'http') => transport === 'mcp'
      ? toolsClient.tool('deviceforge.invoke_device', input) : existing.action(input, transport),
    manage: (id, action_, transport = 'http') => transport === 'mcp'
      ? toolsClient.tool(`deviceforge.${action_}_plugin`, { id }) : existing.manage(id, action_, transport) };
  const remember = () => { report.failed_request ??= { ...report.last_request }; };
  const client = new Proxy(existing, { get(target, name) {
    const value = Object.hasOwn(overrides, name) ? overrides[name] : target[name];
    if (typeof value !== 'function') return value;
    return async (...args) => {
      try { return await value(...args); } catch (error) { remember(); throw error; }
      finally { for (const id of toolsClient.logIds) existing.logIds.add(id); }
    };
  } });
  const download = async (metadata, expected) => {
    const path = `/api/v2/artifacts/${metadata.id}/content`;
    const before = performance.now();
    report.last_request = { path, method: 'GET', started_at: new Date().toISOString() };
    try {
      const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(20000) });
      const logId = response.headers.get('x-deviceforge-log-id');
      report.last_request = { path, method: 'GET', status: response.status, log_id: logId,
        elapsed_ms: performance.now() - before };
      assert.equal(response.status, 200, '产物下载必须成功');
      assert.match(logId, uuid); existing.logIds.add(logId);
      assert.equal(response.headers.get('content-type'), 'application/json');
      assert.equal(Number(response.headers.get('content-length')), expected.length);
      assert.ok(expected.length <= 64 * 1024);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.deepEqual(bytes, expected, '下载必须保留原字节');
      assert.equal(sha256(bytes), metadata.sha256);
      assert.equal(bytes.length, metadata.size);
      JSON.parse(bytes.toString('utf8'));
    } catch (error) { remember(); throw error; }
  };
  return { client, download };
}

export async function terminal(client, id, status = 'succeeded') {
  const job = await poll(() => client.job(id),
    (value) => ['succeeded', 'failed', 'cancelled'].includes(value.status), `共享任务 ${id}`, 30000);
  assert.equal(job.status, status, '共享任务必须为明确终态');
  assert.deepEqual(await client.tool('deviceforge.get_job', { id }), job, 'HTTP/MCP 必须查询同一任务');
  const history = await client.json(`/api/v2/jobs/${id}/events`);
  assert.ok(history.some((event) => event.status === status), '共享事件必须保留任务终态');
  return job;
}

export function publicMetadata(value) {
  assert.deepEqual(Object.keys(value).sort(), ['created_at', 'filename', 'id', 'media_type', 'sha256', 'size'].sort(),
    '产物只允许公开元数据，不得包含服务器路径');
  assert.match(value.id, uuid);
  assert.equal(value.media_type, 'application/json');
  assert.match(value.sha256, /^[\da-f]{64}$/);
}
