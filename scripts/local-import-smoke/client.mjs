// HTTP 与独立 MCP 端口共享任务；报告仅记录关联标识、状态和内容摘要。
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { digest } from './fixtures.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const failureKind = (message) =>
  [
    ['archive_checksum', /SHA-256/],
    ['configuration_io', /配置或清单|部署配置|配置文件|配置插件部署/],
    ['artifact_authorization', /产物|副本/],
    ['manifest_validation', /清单无效|清单结构|清单模块|模块 ID/],
    ['archive_validation', /ZIP|归档|解压/],
    ['revision_conflict', /修订冲突/],
    ['transaction_io', /暂存|安装事务|提交新模块|备份旧模块|回滚/],
    ['execution_budget', /期限|超时|取消/],
    ['plugin_process', /插件.*进程|插件.*响应|协议/],
  ].find(([, pattern]) => pattern.test(String(message)))?.[0] ?? 'unclassified';

export function client(base, mcp, report) {
  let rpcId = 0;
  async function api(path, { method = 'GET', input, bytes, type, status = 200 } = {}) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': type ?? 'application/json' },
      body: bytes ?? (input === undefined ? undefined : JSON.stringify(input)),
      signal: AbortSignal.timeout(15000),
      redirect: 'error',
    });
    const body = await response.json();
    const logId = response.headers.get('x-deviceforge-log-id');
    assert.match(logId ?? '', uuid);
    assert.equal(body.log_id, logId);
    report.requests.push({
      transport: 'http',
      method,
      path: path.replace(/\/jobs\/[^/?]+/, '/jobs/:id'),
      status: response.status,
      log_id: logId,
      error_code: body.error?.code,
    });
    assert.equal(response.status, status, `${method} ${path}`);
    assert.equal(body.error, undefined, `${method} ${path} 应成功`);
    return body.data;
  }
  async function tool(name, input = {}) {
    const id = ++rpcId;
    const response = await fetch(mcp, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        origin: base,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name, arguments: input },
      }),
      signal: AbortSignal.timeout(15000),
      redirect: 'error',
    });
    const body = await response.json();
    const logId = response.headers.get('x-deviceforge-log-id');
    report.requests.push({
      transport: 'mcp',
      method: 'tools/call',
      name,
      status: response.status,
      log_id: logId,
    });
    assert.equal(response.status, 200);
    assert.equal(body.id, id);
    assert.equal(body.error, undefined);
    assert.equal(body.result._meta['deviceforge/log_id'], logId);
    assert.match(logId ?? '', uuid);
    assert.equal(body.result.isError, false, `${name} 应成功`);
    return body.result.structuredContent;
  }
  async function job(
    operation,
    input,
    transport = 'http',
    expected = 'succeeded',
    format = 'artifact_envelope',
  ) {
    const submitted =
      transport === 'mcp'
        ? await tool(operation, input)
        : await api('/api/v2/jobs', { method: 'POST', status: 202, input: { operation, input } });
    assert.match(submitted.id, uuid);
    const evidence = { id: submitted.id, operation, transport, status: submitted.status };
    report.jobs.push(evidence);
    const until = Date.now() + 20000;
    while (Date.now() < until) {
      const current = await api(`/api/v2/jobs/${submitted.id}`);
      if (['failed', 'cancelled', 'succeeded'].includes(current.status)) {
        evidence.status = current.status;
        evidence.error_sha256 = current.error === null ? null : digest(String(current.error));
        evidence.error_kind = current.error === null ? null : failureKind(current.error);
        assert.deepEqual(
          await tool('deviceforge.get_job', { id: current.id }),
          current,
          'HTTP 与 MCP 必须返回相同终态任务',
        );
        evidence.shared_terminal = true;
        assert.equal(
          current.status,
          expected,
          `${operation} 终态不符（${evidence.error_kind ?? '无错误'}）`,
        );
        if (expected !== 'succeeded') return current;
        evidence.result_format = format;
        if (format === 'legacy_json') {
          evidence.result_sha256 = digest(JSON.stringify(current.result));
          return current.result;
        }
        assert.equal(format, 'artifact_envelope');
        assert.deepEqual(current.result.artifacts, [], '夹具业务不应产生额外输出产物');
        evidence.result_sha256 = digest(JSON.stringify(current.result.result));
        return current.result.result;
      }
      await delay(40);
    }
    throw new Error(`${operation} 任务终态超时`);
  }
  async function asset(path, expected) {
    const response = await fetch(new URL(path, base), {
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    });
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(bytes, expected, '插件资源必须保留原始字节');
    const logId = response.headers.get('x-deviceforge-log-id');
    assert.match(logId ?? '', uuid);
    report.requests.push({
      transport: 'http',
      method: 'GET',
      path,
      status: response.status,
      log_id: logId,
    });
    return digest(bytes);
  }
  return {
    base,
    api,
    tool,
    job,
    asset,
    upload: (bytes, filename) =>
      api(`/api/v2/artifacts?filename=${encodeURIComponent(filename)}`, {
        method: 'POST',
        bytes,
        type: 'application/octet-stream',
        status: 201,
      }),
  };
}
