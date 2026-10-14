import assert from 'node:assert/strict';
import test from 'node:test';
import { createFrontendRuntime } from '../src/app/index.ts';
import { PerformanceJobFailure } from '../src/features/performance/index.ts';
import { HostError } from '../src/plugin-sdk/index.ts';
import type { HostContext, JsonValue } from '../src/plugin-sdk/index.ts';
import { deferred, failure, requestUrl, signal, success } from './fixtures.ts';
import { deviceObservation, observationReading } from './performance-observation-fixtures.ts';

const sessionId = '11111111-1111-4111-8111-111111111111';
const startInput = {
  target: { device_id: 'emulator-5554', package: 'com.example.app' },
  interval_ms: 1000,
  duration_secs: 60,
};
const session = {
  id: sessionId,
  request: startInput,
  revision: 1,
  state: 'running',
  samples: 0,
  started_at: 1000,
  updated_at: 1001,
  error: null,
};
const actions = [
  'start',
  'inspect',
  'pause',
  'resume',
  'stop',
  'samples',
  'list',
  'capabilities',
] as const;

function runtime(transport: typeof fetch) {
  return createFrontendRuntime({
    baseUrl: 'http://localhost:7031',
    panelTarget: () => null,
    transport,
  });
}

function invocation(instance: ReturnType<typeof runtime>, request: JsonValue, caller = signal()) {
  const extensions = instance.host.extensions;
  assert.ok(extensions);
  return extensions.callService('host.performance', '1', request, caller);
}

function input(action: (typeof actions)[number]): JsonValue {
  if (action === 'start') return startInput;
  if (action === 'samples') return { session_id: sessionId, after: 0, limit: 2 };
  if (action === 'list') return { limit: 3 };
  return { session_id: sessionId };
}

test('runtime性能服务登记版本1，八操作按严格参数调用且不自动创建或停止会话', async () => {
  const submitted: { operation: string; input: unknown }[] = [];
  const instance = runtime(async (request, init) => {
    assert.equal(requestUrl(request).pathname, '/api/v2/jobs');
    assert.equal(init?.method, 'POST');
    const body: unknown = JSON.parse(String(init.body));
    assert.ok(
      typeof body === 'object' &&
        body !== null &&
        'operation' in body &&
        typeof body.operation === 'string' &&
        'input' in body,
    );
    submitted.push({ operation: body.operation, input: body.input });
    const result = body.operation.endsWith('.samples')
      ? { session, readings: [], next_after: 0 }
      : body.operation.endsWith('.list')
        ? { sessions: [session], next_after_id: sessionId }
        : body.operation.endsWith('.capabilities')
          ? {
              metrics: ['cpu_share_percent', 'cpu_core_percent', 'pss_kib', 'rss_kib'],
              fps: false,
              source: 'plugin.synthetic',
              scope: 'main_process',
              max_samples: 3600,
              sample_timeout_ms: 10000,
            }
          : session;
    return success(
      {
        id: 'performance-job-' + submitted.length,
        operation: body.operation,
        input: body.input,
        created_at: 1,
        status: 'succeeded',
        result,
      },
      'service-log',
    );
  });
  assert.equal(submitted.length, 0);
  assert.equal('performance' in instance.host, false);
  assert.ok(
    instance.host.extensions
      ?.catalog()
      .services.some((entry) => entry.id === 'host.performance' && entry.version === '1'),
  );
  for (const action of actions) {
    const response = await invocation(
      instance,
      action === 'capabilities' ? { action } : { action, input: input(action) },
    );
    assert.equal(response.logId, 'service-log');
    if (action === 'capabilities')
      assert.deepEqual(response.data, {
        metrics: ['cpu_share_percent', 'cpu_core_percent', 'pss_kib', 'rss_kib'],
        fps: false,
        deviceObservation: false,
        sourceLabel: 'plugin.synthetic',
        scope: 'main_process',
        maxSamples: 3600,
        sampleTimeoutMs: 10000,
      });
    else if (action === 'samples')
      assert.deepEqual(response.data, { session, readings: [], next_after: 0 });
    else if (action === 'list')
      assert.deepEqual(response.data, { sessions: [session], next_after_id: sessionId });
    else assert.deepEqual(response.data, session);
  }
  assert.deepEqual(
    submitted.map((request) => request.operation),
    actions.map((action) => 'android.performance.' + action),
  );
  assert.deepEqual(submitted[6]?.input, { after_id: null, limit: 3 });
  await instance.dispose();
  assert.equal(submitted.length, 8);
  await assert.rejects(
    instance.performance.start(startInput, signal()),
    (error: unknown) => error instanceof HostError && error.kind === 'cancelled',
  );
});

test('性能服务拒绝未知字段、越界输入、非有限JSON与未知版本，拒绝前不访问HTTP', async () => {
  let requests = 0;
  const instance = runtime(async () => {
    ++requests;
    throw new Error('无效输入不得触发传输');
  });
  const invalid: JsonValue[] = [
    null,
    [],
    { action: 'unknown' },
    { action: 'capabilities', input: {} },
    { action: 'capabilities', extra: true },
    { action: 'start', input: { ...startInput, source: 'not-a-server-binding' } },
    { action: 'start', input: { ...startInput, interval_ms: 999 } },
    { action: 'pause', input: { session_id: sessionId, revision: 1 } },
    { action: 'inspect', input: { session_id: 'job-id' } },
    { action: 'samples', input: { session_id: sessionId, after: -1, limit: 2 } },
    { action: 'samples', input: { session_id: sessionId, after: 0, limit: 101 } },
    { action: 'list', input: { after_id: [], limit: 1 } },
    { action: 'list', input: { limit: NaN } },
    { action: 'start', input: null },
  ];
  for (const request of invalid)
    await assert.rejects(
      invocation(instance, request),
      (error: unknown) =>
        error instanceof HostError && error.kind === 'protocol' && error.logId === null,
    );
  await assert.rejects(
    invocation(instance, { action: 'capabilities', excess: '字'.repeat(6000) }),
    (error: unknown) => error instanceof HostError && error.code === 'performance_service_limit',
  );
  assert.throws(
    () =>
      instance.host.extensions?.callService(
        'host.performance',
        '2',
        { action: 'capabilities' },
        signal(),
      ),
    (error: unknown) => error instanceof HostError && error.code === 'service_unavailable',
  );
  assert.equal(requests, 0);
  await instance.dispose();
});

test('性能服务保留HTTP错误、失败任务原文和不兼容结果的真实日志', async () => {
  const unavailable = runtime(async () => failure('performance_unavailable', 503));
  await assert.rejects(
    invocation(unavailable, { action: 'capabilities' }),
    (error: unknown) =>
      error instanceof HostError &&
      error.kind === 'http' &&
      error.code === 'performance_unavailable' &&
      error.status === 503 &&
      error.logId === 'log-error',
  );
  await unavailable.dispose();
  const failed = runtime(async () =>
    success(
      {
        id: 'failed-job',
        operation: 'android.performance.inspect',
        input: {},
        created_at: 1,
        status: 'failed',
        error: '资源不存在：性能来源已撤销',
      },
      'failed-log',
    ),
  );
  await assert.rejects(
    invocation(failed, { action: 'inspect', input: { session_id: sessionId } }),
    (error: unknown) =>
      error instanceof PerformanceJobFailure &&
      error.message === '资源不存在：性能来源已撤销' &&
      error.logId === 'failed-log' &&
      error.job.id === 'failed-job',
  );
  await failed.dispose();
  const incompatible = runtime(async () =>
    success(
      {
        id: 'bad-result-job',
        operation: 'android.performance.inspect',
        input: {},
        created_at: 1,
        status: 'succeeded',
        result: { result: session, artifacts: [] },
      },
      'result-log',
    ),
  );
  await assert.rejects(
    invocation(incompatible, { action: 'inspect', input: { session_id: sessionId } }),
    (error: unknown) =>
      error instanceof HostError &&
      error.code === 'invalid_performance_result' &&
      error.logId === 'result-log',
  );
  await incompatible.dispose();
  const oversized = runtime(async () =>
    success(
      {
        id: 'large-job',
        operation: 'android.performance.inspect',
        input: {},
        created_at: 1,
        status: 'succeeded',
        result: { ...session, error: 'x'.repeat(4 * 1024 * 1024) },
      },
      'large-result-log',
    ),
  );
  await assert.rejects(
    invocation(oversized, { action: 'inspect', input: { session_id: sessionId } }),
    (error: unknown) =>
      error instanceof HostError &&
      error.code === 'performance_service_limit' &&
      error.logId === 'large-result-log',
  );
  await oversized.dispose();
});

test('浏览器插件卸载撤销性能在途调用，旧上下文不复活，新代仍可消费同一服务', async () => {
  const pending = deferred<Response>();
  const queried = deferred<void>();
  const contexts: HostContext[] = [];
  const calls: string[] = [];
  const observed: { signal: AbortSignal | null } = { signal: null };
  let submitCount = 0;
  const instance = runtime(async (request, init) => {
    const path = requestUrl(request).pathname;
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (init?.method === 'POST') {
      ++submitCount;
      return success(
        {
          id: 'plugin-performance-job',
          operation: 'android.performance.inspect',
          input: {},
          created_at: 1,
          status: submitCount === 1 ? 'queued' : 'succeeded',
          result: submitCount === 1 ? null : session,
        },
        'plugin-submit-log',
      );
    }
    observed.signal = init?.signal ?? null;
    queried.resolve();
    return pending.promise;
  });
  instance.webPlugins.register({
    id: 'performance-consumer',
    trusted: true,
    plugin: {
      id: 'performance-consumer',
      version: '1',
      apiVersion: 2,
      panels: [],
      activate: async (context) => {
        contexts.push(context);
      },
    },
  });
  await instance.webPlugins.load('performance-consumer');
  const first = contexts[0]?.extensions;
  assert.ok(first);
  const oldCall = first.callService(
    'host.performance',
    '1',
    { action: 'inspect', input: { session_id: sessionId } },
    signal(),
  );
  const rejected = assert.rejects(
    oldCall,
    (error: unknown) => error instanceof HostError && error.kind === 'cancelled',
  );
  await queried.promise;
  await instance.webPlugins.unload('performance-consumer');
  await rejected;
  assert.equal(observed.signal?.aborted, true);
  assert.throws(
    () => first.callService('host.performance', '1', { action: 'capabilities' }, signal()),
    (error: unknown) => error instanceof HostError && error.code === 'extension_revoked',
  );
  pending.resolve(
    success(
      {
        id: 'plugin-performance-job',
        operation: 'android.performance.inspect',
        input: {},
        created_at: 1,
        status: 'succeeded',
        result: session,
      },
      'late-plugin-log',
    ),
  );
  await instance.webPlugins.load('performance-consumer');
  const next = contexts[1]?.extensions;
  assert.ok(next);
  assert.notEqual(next, first);
  const response = await next.callService(
    'host.performance',
    '1',
    { action: 'inspect', input: { session_id: sessionId } },
    signal(),
  );
  assert.equal(response.logId, 'plugin-submit-log');
  assert.deepEqual(response.data, session);
  assert.deepEqual(calls, [
    'POST /api/v2/jobs',
    'GET /api/v2/jobs/plugin-performance-job',
    'POST /api/v2/jobs',
  ]);
  await instance.dispose();
});

test('runtime关闭取消性能在途请求并撤销服务，关闭和晚到结果均不提交stop', async () => {
  const pending = deferred<Response>();
  const queried = deferred<void>();
  const calls: string[] = [];
  const observed: { signal: AbortSignal | null } = { signal: null };
  const instance = runtime(async (request, init) => {
    const path = requestUrl(request).pathname;
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (init?.method === 'POST')
      return success(
        {
          id: 'closing-performance-job',
          operation: 'android.performance.inspect',
          input: {},
          created_at: 1,
          status: 'queued',
        },
        'closing-submit-log',
      );
    observed.signal = init?.signal ?? null;
    queried.resolve();
    return pending.promise;
  });
  const waiting = invocation(instance, { action: 'inspect', input: { session_id: sessionId } });
  const rejected = assert.rejects(
    waiting,
    (error: unknown) => error instanceof HostError && error.kind === 'cancelled',
  );
  await queried.promise;
  await Promise.all([instance.dispose(), instance.dispose()]);
  await rejected;
  assert.equal(observed.signal?.aborted, true);
  assert.throws(
    () =>
      instance.host.extensions?.callService(
        'host.performance',
        '1',
        { action: 'capabilities' },
        signal(),
      ),
    (error: unknown) => error instanceof HostError && error.code === 'registry_closed',
  );
  pending.resolve(
    success(
      {
        id: 'closing-performance-job',
        operation: 'android.performance.inspect',
        input: {},
        created_at: 1,
        status: 'succeeded',
        result: session,
      },
      'late-close-log',
    ),
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls, ['POST /api/v2/jobs', 'GET /api/v2/jobs/closing-performance-job']);
  assert.equal(instance.performance.snapshot().session, null);
});

test('公开性能服务原样交付设备观测和净电池功率，拒绝缺少派生资格的样本', async () => {
  let invalid = false;
  const current = { ...session, samples: 1 };
  const declared = {
    metrics: [
      'cpu_share_percent',
      'cpu_core_percent',
      'pss_kib',
      'rss_kib',
      'fps',
      'device_observation',
      'battery_net_power_mw',
    ],
    fps: true,
    device_observation: true,
    source: 'plugin.android-device',
    scope: 'main_process',
    max_samples: 3600,
    sample_timeout_ms: 10000,
  };
  const instance = runtime(async (_request, init) => {
    const body: unknown = JSON.parse(String(init?.body));
    assert.ok(
      typeof body === 'object' &&
        body !== null &&
        'operation' in body &&
        typeof body.operation === 'string',
    );
    const battery = deviceObservation().battery;
    assert.ok(battery);
    const reading = invalid
      ? {
          ...observationReading(),
          device_observation: {
            ...deviceObservation(),
            battery: { ...battery, current_polarity: 'unknown' },
          },
        }
      : observationReading();
    const result = body.operation.endsWith('.samples')
      ? { session: current, readings: [reading], next_after: 1 }
      : body.operation.endsWith('.capabilities')
        ? declared
        : current;
    return success(
      {
        id: 'observation-service-job',
        operation: body.operation,
        input: {},
        created_at: 1,
        status: 'succeeded',
        result,
      },
      'observation-service-log',
    );
  });
  try {
    await instance.performance.select(sessionId, signal());
    const response = await invocation(instance, {
      action: 'samples',
      input: { session_id: sessionId, after: 0, limit: 1 },
    });
    assert.equal(response.logId, 'observation-service-log');
    assert.deepEqual(response.data, {
      session: current,
      readings: [observationReading()],
      next_after: 1,
    });
    assert.equal(instance.performance.snapshot().readings[0]?.battery_net_power_mw, -8000);
    const capabilities = await invocation(instance, { action: 'capabilities' });
    assert.deepEqual(capabilities.data, {
      metrics: declared.metrics,
      fps: true,
      deviceObservation: true,
      sourceLabel: declared.source,
      scope: 'main_process',
      maxSamples: 3600,
      sampleTimeoutMs: 10000,
    });
    invalid = true;
    await assert.rejects(
      invocation(instance, {
        action: 'samples',
        input: { session_id: sessionId, after: 0, limit: 1 },
      }),
      (error: unknown) =>
        error instanceof HostError &&
        error.code === 'invalid_performance_result' &&
        error.logId === 'observation-service-log',
    );
    assert.equal(instance.performance.snapshot().nextAfter, 1);
    assert.deepEqual(instance.performance.snapshot().readings, [observationReading()]);
  } finally {
    await instance.dispose();
  }
});
