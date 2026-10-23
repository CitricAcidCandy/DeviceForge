import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, createApiClient, isPluginRecoveryView, pluginRecoveryEndpoint, recoverPluginEndpoint } from '../src/services/api/index.ts';
import { failure, requestUrl, signal, success } from './fixtures.ts';

function report() {
  return { status: 'recovered', coverage: 'plugin', inspected: 3, remaining: 0, message: '资源核对通过',
    checks: [{ resource: 'control', status: 'confirmed', message: '无遗留控制连接' }] };
}
function view(lastReport: unknown = report()) {
  return { id: 'mirroring', generation: 'generation-1', supported: true,
    cleanup_failed: false, recovering: false, last_report: lastReport };
}

test('恢复 GET/POST 使用公共客户端和 v2 包装，保留成功日志 ID', async () => {
  const calls: { path: string; method: string | undefined; body: unknown }[] = [];
  const client = createApiClient({ baseUrl: 'http://localhost', transport: async (input, init) => {
    calls.push({ path: requestUrl(input).pathname, method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : null });
    return success(view(), 'recovery-log');
  } });
  assert.equal((await client.call(pluginRecoveryEndpoint, 'mirroring', signal())).logId, 'recovery-log');
  const result = await client.call(recoverPluginEndpoint, {
    id: 'mirroring', body: { generation: 'generation-1', input: { device_id: 'test-device' } },
  }, signal());
  assert.equal(result.logId, 'recovery-log');
  assert.deepEqual(calls, [
    { path: '/api/v2/plugins/mirroring/recovery', method: 'GET', body: null },
    { path: '/api/v2/plugins/mirroring/recovery', method: 'POST',
      body: { generation: 'generation-1', input: { device_id: 'test-device' } } },
  ]);
});

test('恢复报告必填全插件覆盖和非负整数计数，损坏响应全部拒绝', () => {
  const valid = view();
  assert.ok(isPluginRecoveryView(valid));
  assert.ok(isPluginRecoveryView(view(null)));
  const damaged: unknown[] = [
    null, [], {}, { ...valid, id: '' }, { ...valid, generation: ' ' },
    { ...valid, supported: 'true' }, { ...valid, cleanup_failed: undefined },
    { ...valid, recovering: 0 }, { ...valid, last_report: undefined },
    view({ ...report(), coverage: undefined }), view({ ...report(), coverage: 'device' }),
    ...[undefined, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].flatMap((count) => [
      view({ ...report(), inspected: count }), view({ ...report(), remaining: count }),
    ]),
    view({ ...report(), message: null }), view({ ...report(), status: 'done' }),
    view({ ...report(), checks: null }), view({ ...report(), checks: [{ resource: ' ', status: 'confirmed', message: '' }] }),
    view({ ...report(), checks: [{ resource: 'control', status: 'ok', message: '' }] }),
    view({ ...report(), checks: [{ resource: 'control', status: 'confirmed', message: 1 }] }),
    view({ ...report(), checks: Array.from({ length: 65 }, () => report().checks[0]) }),
  ];
  for (const candidate of damaged) assert.equal(isPluginRecoveryView(candidate), false, JSON.stringify(candidate));
});

test('已恢复必须未确认为零且检查非空、全部确认；blocked 与 busy 可保留未确认数量', () => {
  assert.equal(isPluginRecoveryView(view({ ...report(), remaining: 1 })), false);
  assert.equal(isPluginRecoveryView(view({ ...report(), checks: [] })), false);
  for (const status of ['blocked', 'busy']) {
    const checks = [{ resource: 'control', status, message: '资源仍在使用' }];
    assert.equal(isPluginRecoveryView(view({ ...report(), checks })), false);
    assert.equal(isPluginRecoveryView(view({ ...report(), status, remaining: 2, checks })), true);
  }
});

test('SDK 三类文本按 Unicode 码点检查非空和 500 字符上限，64 项明细可接受', () => {
  const candidates = (text: unknown) => [
    view({ ...report(), message: text }),
    view({ ...report(), checks: [{ resource: text, status: 'confirmed', message: '已确认' }] }),
    view({ ...report(), checks: [{ resource: 'control', status: 'confirmed', message: text }] }),
  ];
  for (const text of ['a'.repeat(500), '核'.repeat(500), '\u{1f600}'.repeat(500)])
    for (const candidate of candidates(text)) assert.equal(isPluginRecoveryView(candidate), true);
  for (const text of ['', null, undefined, 500, 'a'.repeat(501), '\u{1f600}'.repeat(501)])
    for (const candidate of candidates(text)) assert.equal(isPluginRecoveryView(candidate), false);
  assert.equal(isPluginRecoveryView(view({ ...report(),
    checks: Array.from({ length: 64 }, () => ({ resource: 'control', status: 'confirmed', message: '已确认' })),
  })), true);
});

test('HTTP unknown 文本损坏同样拒绝且每次保留该响应日志 ID', async () => {
  for (const [index, malformed] of [
    view({ ...report(), message: '' }),
    view({ ...report(), checks: [{ resource: 'a'.repeat(501), status: 'confirmed', message: '已确认' }] }),
    view({ ...report(), checks: [{ resource: 'control', status: 'confirmed', message: '' }] }),
  ].entries()) {
    const logId = `invalid-recovery-text-${index}`;
    const client = createApiClient({ baseUrl: 'http://localhost', transport: async () => success(malformed, logId) });
    await assert.rejects(client.call(pluginRecoveryEndpoint, 'mirroring', signal()),
      (error: unknown) => error instanceof ApiError && error.kind === 'protocol' && error.logId === logId);
  }
});

test('损坏恢复响应通过公共协议错误保留本次日志，HTTP 冲突保留原日志', async () => {
  let invalid = true;
  const client = createApiClient({ baseUrl: 'http://localhost', transport: async () => invalid
    ? success(view({ ...report(), remaining: 4 }), 'bad-report-log') : failure('conflict') });
  await assert.rejects(client.call(pluginRecoveryEndpoint, 'mirroring', signal()),
    (error: unknown) => error instanceof ApiError && error.kind === 'protocol' && error.logId === 'bad-report-log');
  invalid = false;
  await assert.rejects(client.call(pluginRecoveryEndpoint, 'mirroring', signal()),
    (error: unknown) => error instanceof ApiError && error.code === 'conflict' && error.logId === 'log-error');
});

test('恢复提交拒绝空代际及非 JSON 输入，不发送网络请求', () => {
  assert.throws(() => recoverPluginEndpoint.request({ id: 'mirroring', body: { generation: '', input: {} } }));
  assert.throws(() => recoverPluginEndpoint.request({ id: 'mirroring', body: { generation: 'g1', input: { value: NaN } } }));
});
