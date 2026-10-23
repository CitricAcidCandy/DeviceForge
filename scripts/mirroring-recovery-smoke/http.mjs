import assert from 'node:assert/strict';

export const recoveryPath = '/api/v2/plugins/mirroring/recovery';
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

// 恢复操作预算为 30 秒，请求预算另留传输余量，不重放 POST。
export function createHttp(base, report, { fetcher = fetch, timeout = 38000 } = {}) {
  const endpoint = new URL(base);
  assert.equal(endpoint.hostname, '127.0.0.1', '只允许本机隔离宿主');
  assert.equal(endpoint.protocol, 'http:');
  assert.ok(!['7031', '5173', ''].includes(endpoint.port), '禁止用户现场或默认端口');
  assert.ok(!endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash);
  const logIds = new Set();
  const call = async (path, { method = 'GET', input, signal } = {}) => {
    assert.ok(path.startsWith('/api/v2/') && !path.includes('://'));
    const started = performance.now();
    const record = { path, method, started_at: new Date().toISOString() };
    (report.requests ??= []).push(record);
    let response;
    try {
      const deadline = AbortSignal.timeout(timeout);
      response = await fetcher(new URL(path, endpoint), {
        method, headers: { 'content-type': 'application/json' },
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      });
      record.status = response.status;
      record.log_id = response.headers.get('x-deviceforge-log-id');
      assert.match(record.log_id, uuid, '响应须携带日志 ID');
      logIds.add(record.log_id);
      const body = await response.json();
      assert.equal(body.log_id, record.log_id, '响应体与响应头日志 ID 必须相同');
      record.code = body.error?.code;
      record.outcome = 'returned';
      return { status: response.status, body, logId: record.log_id };
    } catch (error) {
      record.outcome = 'threw';
      record.error_name = error.name;
      throw error;
    } finally { record.elapsed_ms = performance.now() - started; }
  };
  const json = async (path, { status = 200, ...options } = {}) => {
    const reply = await call(path, options);
    assert.equal(reply.status, status, 'HTTP 状态不符：' + path);
    assert.equal(reply.body.error, undefined);
    assert.ok(Object.hasOwn(reply.body, 'data'), '响应须有 data');
    return reply.body.data;
  };
  return {
    base: endpoint.origin, logIds, call, json,
    post: (path, input, options = {}) => json(path, { method: 'POST', input, ...options }),
    recovery: () => json(recoveryPath),
    recover: (generation, device) => json(recoveryPath, {
      method: 'POST', input: { generation, input: { device_id: device } },
    }),
  };
}

export function assertRecoveryView(value, { generation, supported, freshReport = false } = {}) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.equal(value.id, 'mirroring');
  assert.match(value.generation, uuid);
  if (generation !== undefined) assert.equal(value.generation, generation);
  if (supported !== undefined) assert.equal(value.supported, supported);
  for (const key of ['supported', 'cleanup_failed', 'recovering']) assert.equal(typeof value[key], 'boolean');
  assert.ok(Object.hasOwn(value, 'last_report'));
  if (value.last_report !== null) {
    const item = value.last_report;
    assert.ok(['recovered', 'blocked', 'busy'].includes(item.status));
    assert.equal(item.coverage, 'plugin', '报告必须声明插件级覆盖');
    for (const key of ['inspected', 'remaining'])
      assert.ok(Number.isInteger(item[key]) && item[key] >= 0 && item[key] <= 0xffffffff, '覆盖计数必须为 u32');
    assert.equal(typeof item.message, 'string');
    assert.ok(item.message.trim().length > 0);
    assert.ok(Array.isArray(item.checks));
    for (const check of item.checks) {
      assert.equal(typeof check.resource, 'string');
      assert.ok(check.resource.trim().length > 0);
      assert.ok(['confirmed', 'blocked', 'busy'].includes(check.status));
      assert.equal(typeof check.message, 'string');
      assert.ok(check.message.trim().length > 0);
    }
    if (item.status === 'recovered') {
      // GET 的最近报告可能早于新故障；只有本次 POST 成功确认才要求风险已解除。
      if (freshReport) assert.equal(value.cleanup_failed, false, '本次恢复成功必须解除本代风险');
      assert.equal(item.remaining, 0, '仍有资源债务时不能伪装成功');
      assert.ok(item.checks.length > 0, '空检查不能证明恢复');
      assert.ok(item.checks.every((check) => check.status === 'confirmed'), '有阻断或忙碌项不能伪装成功');
    }
  }
  return value;
}

// 报告仅保留状态及检查数量，不复制任意插件消息或设备输入。
export function recoverySummary(value) {
  return {
    id: value.id, generation: value.generation, supported: value.supported,
    cleanup_failed: value.cleanup_failed, recovering: value.recovering,
    last_report: value.last_report === null ? null : {
      status: value.last_report.status,
      coverage: value.last_report.coverage,
      inspected: value.last_report.inspected, remaining: value.last_report.remaining,
      checks: value.last_report.checks.map(({ status }) => ({ status })),
    },
  };
}
