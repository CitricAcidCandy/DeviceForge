import assert from 'node:assert/strict';
import test from 'node:test';
import { createHttpPerformance, PerformanceJobFailure, PerformanceWaitFailure } from '../src/features/performance/index.ts';
import { ApiError, createApiClient } from '../src/shared/api/index.ts';
import { HostError } from '../src/plugin-sdk/index.ts';
import { deferred, failure, requestUrl, signal, success } from './fixtures.ts';

const sessionId = '11111111-1111-4111-8111-111111111111';
const startInput = { target: { device_id: 'emulator-5554', package: 'com.example.app' }, interval_ms: 1000, duration_secs: 60 };
const session = { id: sessionId, request: startInput, revision: 1, state: 'running', samples: 0, started_at: 1000, updated_at: 1001, error: null };

function task(operation: string, result: unknown, status = 'succeeded', id = 'performance-job') {
  return { id, operation, input: {}, created_at: 1, status, result, error: null };
}

test('HTTP性能八操作只走现有jobs，排队后查询同任务并保留提交与终态日志', async () => {
  const submitted: { operation: string; input: unknown }[] = [];
  const paths: string[] = [];
  let polls = 0;
  const client = createApiClient({ baseUrl: 'http://localhost:7031', transport: async (request, init) => {
    const path = requestUrl(request).pathname; paths.push(path);
    if (path === '/api/v2/jobs' && init?.method === 'POST') {
      const body: unknown = JSON.parse(String(init.body));
      assert.ok(typeof body === 'object' && body !== null && 'operation' in body && typeof body.operation === 'string' && 'input' in body);
      submitted.push({ operation: body.operation, input: body.input }); polls = 0;
      return success(task(body.operation, null, 'queued'), 'submit-log');
    }
    assert.equal(path, '/api/v2/jobs/performance-job');
    const current = submitted.at(-1); assert.ok(current);
    if (++polls === 1) return success(task(current.operation, null, 'running'), 'running-log');
    const result = current.operation.endsWith('.samples') ? { session, readings: [], next_after: 0 }
      : current.operation.endsWith('.list') ? { sessions: [session], next_after_id: sessionId }
      : current.operation.endsWith('.capabilities') ? { metrics: ['cpu_share_percent', 'cpu_core_percent', 'pss_kib', 'rss_kib'], fps: false, source: 'plugin.synthetic', scope: 'main_process', max_samples: 3600, sample_timeout_ms: 10000 }
      : session;
    return success(task(current.operation, result), 'terminal-log');
  } });
  const performance = createHttpPerformance(client, { pollIntervalMs: 0 });
  const outcomes = [await performance.start(startInput, signal()), await performance.inspect(sessionId, signal()),
    await performance.pause(sessionId, signal()), await performance.resume(sessionId, signal()), await performance.stop(sessionId, signal()),
    await performance.samples(sessionId, { after: 0, limit: 2 }, signal()), await performance.list({ limit: 3 }, signal()), await performance.capabilities(signal())];
  for (const outcome of outcomes) {
    assert.equal(outcome.submitLogId, 'submit-log'); assert.equal(outcome.logId, 'terminal-log');
    assert.equal(outcome.job.id, 'performance-job'); assert.equal(outcome.job.status, 'succeeded'); assert.equal(outcome.job.error, null);
  }
  assert.deepEqual(submitted.map((item) => item.operation), ['start', 'inspect', 'pause', 'resume', 'stop', 'samples', 'list', 'capabilities'].map((action) => 'android.performance.' + action));
  assert.deepEqual(submitted.map((item) => item.input), [startInput, { session_id: sessionId }, { session_id: sessionId }, { session_id: sessionId },
    { session_id: sessionId }, { session_id: sessionId, after: 0, limit: 2 }, { after_id: null, limit: 3 }, {}]);
  const capabilities = outcomes[7]?.data;
  assert.equal(paths.length, 24); assert.ok(capabilities && 'sourceLabel' in capabilities);
  assert.equal(capabilities.sourceLabel, 'plugin.synthetic'); performance.dispose();
});

test('HTTP性能消费保留网络错误和失败任务日志，拒绝错误身份与sample封套', async () => {
  const unavailable = createHttpPerformance(createApiClient({ baseUrl: 'http://localhost:7031', transport: async () => failure('source_unavailable', 503) }));
  await assert.rejects(unavailable.capabilities(signal()), (error: unknown) => error instanceof ApiError && error.code === 'source_unavailable' && error.logId === 'log-error');
  unavailable.dispose();
  const failed = createHttpPerformance(createApiClient({ baseUrl: 'http://localhost:7031', transport: async () => success({ ...task('android.performance.inspect', null, 'failed'), error: '资源不存在：性能采样源已撤销' }, 'job-failed-log') }));
  await assert.rejects(failed.inspect(sessionId, signal()), (error: unknown) => error instanceof PerformanceJobFailure
    && error.message === '资源不存在：性能采样源已撤销' && error.job.id === 'performance-job' && error.logId === 'job-failed-log');
  failed.dispose();
  for (const result of [{ ...session, id: '22222222-2222-4222-8222-222222222222' }, { result: session, artifacts: [] }]) {
    const invalid = createHttpPerformance(createApiClient({ baseUrl: 'http://localhost:7031', transport: async () => success(task('android.performance.inspect', result), 'invalid-log') }));
    await assert.rejects(invalid.inspect(sessionId, signal()), (error: unknown) => error instanceof HostError && error.code === 'invalid_performance_result' && error.logId === 'invalid-log');
    invalid.dispose();
  }
});

test('HTTP性能等待取消保留已提交任务，销毁不发cancel或stop且晚到响应不更新快照', async () => {
  const pending = deferred<Response>(); const queried = deferred<void>(); const methods: string[] = [];
  const requestState: { signal: AbortSignal | null } = { signal: null };
  const performance = createHttpPerformance(createApiClient({ baseUrl: 'http://localhost:7031', transport: async (request, init) => {
    methods.push(`${init?.method ?? 'GET'} ${requestUrl(request).pathname}`);
    if (init?.method === 'POST') return success(task('android.performance.inspect', null, 'queued'), 'submit-log');
    requestState.signal = init?.signal ?? null; queried.resolve(); return pending.promise;
  } }), { pollIntervalMs: 0 });
  const cancellation = new AbortController(); const observation = performance.select(sessionId, cancellation.signal);
  const rejected = assert.rejects(observation, (error: unknown) => error instanceof PerformanceWaitFailure && error.job.id === 'performance-job' && error.submitLogId === 'submit-log');
  await queried.promise; cancellation.abort(); await rejected;
  assert.ok(requestState.signal); assert.equal(requestState.signal.aborted, true); assert.equal(performance.snapshot().session, null);
  performance.dispose(); pending.resolve(success(task('android.performance.inspect', session), 'late-log'));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(performance.snapshot().session, null);
  assert.deepEqual(methods, ['POST /api/v2/jobs', 'GET /api/v2/jobs/performance-job']);
  await assert.rejects(performance.start(startInput, signal()), (error: unknown) => error instanceof HostError && error.kind === 'cancelled');
});
