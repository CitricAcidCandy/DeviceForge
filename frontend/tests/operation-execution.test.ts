import assert from 'node:assert/strict';
import test from 'node:test';
import { createFrontendRuntime } from '../src/app/index.ts';
import { publicCall, publicOperation } from '../src/app/public-api.ts';
import { HostError } from '../src/plugin-sdk/index.ts';
import type { Operation } from '../src/plugin-sdk/index.ts';
import { ApiError, createApiClient, operationsEndpoint } from '../src/shared/api/index.ts';
import { isOperationExecution } from '../src/shared/api/operation-execution-validation.ts';
import { isOperation } from '../src/shared/api/validation.ts';
import { job, requestUrl, signal, success } from './fixtures.ts';

// 夹具先作为未知响应消费，不复制生成 DTO，也不把预算放入提交参数。
function operation(execution: unknown = undefined, id = 'example.run') {
  return { id, title: '普通操作', input_schema: { type: 'object' },
    ...(execution === undefined ? {} : { execution }),
  };
}
const invalidExecutions: readonly unknown[] = [
  1, '60000', true, [], {},
  { api_version: 1, total_timeout_ms: 60000 },
  { api_version: 1, source: 'default' },
  { total_timeout_ms: 60000, source: 'default' },
  ...[0, 2, '1', true, null].map((version) => ({ api_version: version, total_timeout_ms: 60000, source: 'default' })),
  ...[0, -1, 3600001, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, '60000', true, null]
    .map((timeout) => ({ api_version: 1, total_timeout_ms: timeout, source: 'declared' })),
  ...['unknown', 'Default', '', 1, null].map((source) => ({ api_version: 1, total_timeout_ms: 60000, source })),
  { api_version: 1, total_timeout_ms: 60000, source: 'default', extra: true },
  { apiVersion: 1, totalTimeoutMs: 60000, source: 'default' },
];

test('普通预算校验接受缺省/null及闭区间安全整数，拒绝非法对象而不补正', () => {
  for (const execution of [undefined, null,
    { api_version: 1, total_timeout_ms: 1, source: 'default' },
    { api_version: 1, total_timeout_ms: 3600000, source: 'declared' },
  ]) {
    assert.equal(isOperationExecution(execution), true);
    assert.equal(isOperation(operation(execution)), true);
  }
  for (const execution of invalidExecutions) {
    assert.equal(isOperationExecution(execution), false);
    assert.equal(isOperation(operation(execution)), false);
  }
});

test('旧目录缺省/null在公开查询和订阅中均省略execution，不猜测60秒', async () => {
  for (const execution of [undefined, null]) {
    const runtime = createFrontendRuntime({ baseUrl: 'http://localhost:7031', panelTarget: () => null,
      transport: async () => success([operation(execution)], 'legacy-operation-log'),
    });
    try {
      const seen: (readonly Operation[])[] = [];
      const release = runtime.host.subscribeOperations((entries) => { seen.push(entries); });
      const listed = await runtime.host.listOperations(signal());
      assert.equal(listed.logId, 'legacy-operation-log');
      const entry = listed.data[0]; assert.ok(entry);
      assert.equal(entry.execution, undefined);
      assert.equal(Object.hasOwn(entry, 'execution'), false);
      await runtime.operations.refresh(signal());
      const observed = seen[0]?.[0]; assert.ok(observed);
      assert.equal(Object.hasOwn(observed, 'execution'), false);
      await release();
    } finally { await runtime.dispose(); }
  }
});

test('目录明示的有效预算及旧别名逐项映射camelCase，查询与订阅一致', async () => {
  const declared = { api_version: 1, total_timeout_ms: 3600000, source: 'declared' };
  const wire = [operation({ api_version: 1, total_timeout_ms: 1, source: 'default' }, 'minimum'),
    operation({ api_version: 1, total_timeout_ms: 60000, source: 'default' }, 'default'),
    operation(declared, 'long.run'), operation(declared, 'legacy.alias'), operation(undefined, 'device.special')];
  const runtime = createFrontendRuntime({ baseUrl: 'http://localhost:7031', panelTarget: () => null,
    transport: async () => success(wire, 'explicit-operation-log'),
  });
  try {
    const seen: (readonly Operation[])[] = [];
    runtime.host.subscribeOperations((entries) => { seen.push(entries); });
    const listed = await runtime.host.listOperations(signal());
    assert.equal(listed.logId, 'explicit-operation-log');
    assert.deepEqual(listed.data.map((entry) => entry.execution), [
      { apiVersion: 1, totalTimeoutMs: 1, source: 'default' },
      { apiVersion: 1, totalTimeoutMs: 60000, source: 'default' },
      { apiVersion: 1, totalTimeoutMs: 3600000, source: 'declared' },
      { apiVersion: 1, totalTimeoutMs: 3600000, source: 'declared' }, undefined,
    ]);
    for (const entry of listed.data) if (entry.execution) {
      assert.equal(Object.hasOwn(entry.execution, 'api_version'), false);
      assert.equal(Object.hasOwn(entry.execution, 'total_timeout_ms'), false);
    }
    await runtime.operations.refresh(signal());
    assert.deepEqual(seen, [listed.data]);
    assert.deepEqual(wire[2]?.execution, declared);
    assert.equal(Object.hasOwn(listed.data[4] ?? {}, 'execution'), false);
  } finally { await runtime.dispose(); }
});

test('非法预算不能进入目录，HTTP与SDK协议错误保留响应日志ID', async () => {
  let execution: unknown = null;
  const transport: typeof fetch = async () => success([operation(execution)], 'invalid-execution-log');
  const client = createApiClient({ baseUrl: 'http://localhost:7031', transport });
  const runtime = createFrontendRuntime({ baseUrl: 'http://localhost:7031', panelTarget: () => null, transport });
  try {
    for (const invalid of invalidExecutions) {
      execution = invalid;
      await assert.rejects(client.call(operationsEndpoint, undefined, signal()), (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.kind, 'protocol'); assert.equal(error.code, 'invalid_response');
        assert.equal(error.logId, 'invalid-execution-log'); assert.equal(error.status, 200); return true;
      });
      await assert.rejects(runtime.host.listOperations(signal()), (error: unknown) => {
        assert.ok(error instanceof HostError);
        assert.equal(error.kind, 'protocol'); assert.equal(error.code, 'invalid_response');
        assert.equal(error.logId, 'invalid-execution-log'); assert.equal(error.status, 200); return true;
      });
    }
  } finally { await runtime.dispose(); }
});

test('公开映射自身拒绝非法预算，publicCall补入真实响应日志而不裁剪', async () => {
  const dto = operation({ api_version: 1, total_timeout_ms: 60000, source: 'default' });
  assert.ok(isOperation(dto));
  const execution = dto.execution; assert.ok(execution);
  const malformed = { ...dto, execution: { ...execution, total_timeout_ms: 0 } };
  await assert.rejects(publicCall(Promise.resolve({ data: malformed, logId: 'mapping-execution-log' }), publicOperation),
    (error: unknown) => {
      assert.ok(error instanceof HostError);
      assert.equal(error.kind, 'protocol'); assert.equal(error.code, 'invalid_execution');
      assert.equal(error.logId, 'mapping-execution-log'); return true;
    });
});

test('预算只属于当前目录，业务提交原样发送且历史Job不补当前元数据', async () => {
  let catalog: readonly unknown[] = [operation({ api_version: 1, total_timeout_ms: 3600000, source: 'declared' })];
  const historical = { ...job('old-job'), status: 'succeeded', result: { result: { value: '旧结果' }, artifacts: [] } };
  const businessInput = { payload: '业务输入', execution: { note: '这是业务字段' } };
  let submissions = 0; let reads = 0; let directoryReads = 0;
  const runtime = createFrontendRuntime({ baseUrl: 'http://localhost:7031', panelTarget: () => null,
    transport: async (input, init) => {
      const path = requestUrl(input).pathname;
      if (path === '/api/v2/operations') { ++directoryReads; return success(catalog, 'current-directory-log'); }
      if (path === '/api/v2/jobs' && init?.method === 'POST') {
        ++submissions;
        assert.equal(init.body, JSON.stringify({ operation: 'example.run', input: businessInput }));
        return success(job('submitted'), 'submitted-log', 202);
      }
      assert.equal(path, '/api/v2/jobs/old-job'); ++reads;
      return success(historical, 'historical-job-log');
    },
  });
  try {
    const before = await runtime.host.getJob('old-job', signal());
    await runtime.host.listOperations(signal());
    const submitted = await runtime.host.submit('example.run', businessInput, signal());
    assert.equal(submitted.data.id, 'submitted'); assert.equal(submitted.logId, 'submitted-log');
    catalog = [operation({ api_version: 1, total_timeout_ms: 60000, source: 'default' })];
    await runtime.host.listOperations(signal());
    assert.deepEqual(await runtime.host.getJob('old-job', signal()), before);
    catalog = []; runtime.operations.invalidate();
    await runtime.operations.refresh(signal());
    assert.deepEqual(await runtime.host.getJob('old-job', signal()), before);
    assert.deepEqual(Object.keys(before.data).sort(), ['error', 'id', 'operation', 'result', 'status']);
    assert.deepEqual(before.data.result, historical.result);
    assert.equal(before.data.error, null); assert.equal(before.logId, 'historical-job-log');
    assert.equal(submissions, 1); assert.equal(reads, 3); assert.equal(directoryReads, 3);
  } finally { await runtime.dispose(); }
});
