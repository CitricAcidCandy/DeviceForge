import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPerformance,
  PerformanceJobFailure,
  PerformanceWaitFailure,
} from '../src/features/performance/index.ts';
import type { PerformanceGateway } from '../src/features/performance/index.ts';
import { HostError } from '../src/plugin-sdk/index.ts';
import type { HostResult, Job, JsonValue } from '../src/plugin-sdk/index.ts';
import { deferred, signal } from './fixtures.ts';

const firstId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
const request = {
  target: { device_id: 'emulator-5554', package: 'com.example.app' },
  interval_ms: 1000,
  duration_secs: 60,
};
function session(
  id = firstId,
  revision = 1,
  state = 'running',
  samples = 0,
): { [key: string]: JsonValue } {
  return {
    id,
    request,
    revision,
    state,
    samples,
    started_at: 1000,
    updated_at: 1000 + revision,
    error: null,
  };
}
function complete(operation: string, result: JsonValue, jobId = 'job-1'): HostResult<Job> {
  return {
    data: { id: jobId, operation, status: 'succeeded', result, error: null },
    logId: 'query-log',
  };
}
function immediate(
  respond: (operation: string, input: JsonValue) => JsonValue,
): PerformanceGateway {
  return {
    submit: async (operation, input) => complete(operation, respond(operation, input)),
    getJob: async () => {
      throw new Error('终态提交结果不应继续轮询');
    },
  };
}

test('八会话操作构造原 wire 并分别消费直接业务结果', async () => {
  const calls: { operation: string; input: JsonValue }[] = [];
  const consumer = createPerformance(
    immediate((operation, input) => {
      calls.push({ operation, input });
      if (operation.endsWith('.capabilities'))
        return {
          metrics: ['cpu_share_percent', 'cpu_core_percent', 'pss_kib', 'rss_kib'],
          fps: false,
          source: 'plugin.synthetic',
          scope: 'main_process',
          max_samples: 3600,
          sample_timeout_ms: 10000,
        };
      if (operation.endsWith('.samples'))
        return { session: session(), readings: [], next_after: 0 };
      if (operation.endsWith('.list')) return { sessions: [session()], next_after_id: firstId };
      if (operation.endsWith('.pause')) return session(firstId, 2, 'paused');
      if (operation.endsWith('.resume')) return session(firstId, 3);
      if (operation.endsWith('.stop')) return session(firstId, 4, 'stopped');
      return session();
    }),
  );
  assert.equal((await consumer.start(request, signal())).data.id, firstId);
  await consumer.inspect(firstId, signal());
  await consumer.pause(firstId, signal());
  await consumer.resume(firstId, signal());
  await consumer.stop(firstId, signal());
  await consumer.samples(firstId, { after: 0, limit: 2 }, signal());
  await consumer.list({ limit: 3 }, signal());
  assert.equal((await consumer.capabilities(signal())).data.sourceLabel, 'plugin.synthetic');
  assert.equal(calls.length, 8);
  assert.deepEqual(calls[0]?.input, request);
  assert.deepEqual(calls[1]?.input, { session_id: firstId });
  assert.deepEqual(calls[5]?.input, { session_id: firstId, after: 0, limit: 2 });
  assert.deepEqual(calls[6]?.input, { after_id: null, limit: 3 });
  assert.deepEqual(calls[7]?.input, {});
  consumer.dispose();
});

test('创建返回来源为权威，输入不包含客户端代次且旧缺省不反填', async () => {
  let inputSeen: JsonValue = null;
  const returned = {
    ...session(),
    source: {
      plugin_id: 'android-device',
      generation: 'new-generation',
      operation: 'plugin.android-device.performance.sample',
      device: {
        provider_id: 'android-device',
        generation: 'new-generation',
        local_id: 'emulator-5554',
      },
    },
  };
  const consumer = createPerformance(
    immediate((_operation, input) => {
      inputSeen = input;
      return returned;
    }),
  );
  const result = await consumer.start(request, signal());
  assert.equal(result.data, returned);
  assert.deepEqual(inputSeen, request);
  assert.equal(consumer.snapshot().selection, null);
  consumer.dispose();
  const legacy = createPerformance(immediate(() => session()));
  assert.equal('source' in (await legacy.start(request, signal())).data, false);
  legacy.dispose();
});

test('等待真实 Job 终态并分别保留提交、查询日志与失败原文本', async () => {
  let polls = 0;
  const consumer = createPerformance(
    {
      submit: async (operation) => ({
        data: { id: 'job-1', operation, status: 'queued', result: null, error: null },
        logId: 'submit-log',
      }),
      getJob: async () => {
        ++polls;
        return complete('android.performance.inspect', session());
      },
    },
    { pollIntervalMs: 0 },
  );
  const result = await consumer.inspect(firstId, signal());
  assert.equal(polls, 1);
  assert.equal(result.submitLogId, 'submit-log');
  assert.equal(result.logId, 'query-log');
  consumer.dispose();
  const failing = createPerformance({
    submit: async (operation) => ({
      data: {
        id: 'job-failed',
        operation,
        status: 'failed',
        result: null,
        error: '资源不存在：性能采样源不可用',
      },
      logId: 'real-log',
    }),
    getJob: async () => {
      throw new Error('失败不应轮询');
    },
  });
  await assert.rejects(
    failing.start(request, signal()),
    (error: unknown) =>
      error instanceof PerformanceJobFailure &&
      error.message === '资源不存在：性能采样源不可用' &&
      error.job.error === error.message &&
      error.logId === 'real-log',
  );
  failing.dispose();
});

test('八操作均拒绝 sample 封套，查询身份错误保留真实日志', async () => {
  const consumer = createPerformance(immediate(() => ({ result: session(), artifacts: [] })));
  const actions = [
    () => consumer.start(request, signal()),
    () => consumer.inspect(firstId, signal()),
    () => consumer.pause(firstId, signal()),
    () => consumer.stop(firstId, signal()),
    () => consumer.samples(firstId, { after: 0, limit: 1 }, signal()),
    () => consumer.list({ limit: 1 }, signal()),
    () => consumer.capabilities(signal()),
  ];
  for (const run of actions)
    await assert.rejects(
      run(),
      (error: unknown) => error instanceof HostError && error.code === 'invalid_performance_result',
    );
  // resume 在控制失败后须先重查；独立消费者验证其结果分支。
  const resume = createPerformance(immediate(() => ({ result: session(), artifacts: [] })));
  await assert.rejects(
    resume.resume(firstId, signal()),
    (error: unknown) => error instanceof HostError && error.code === 'invalid_performance_result',
  );
  resume.dispose();
  consumer.dispose();
  const wrong = createPerformance(
    {
      submit: async (operation) => ({
        data: { id: 'expected-job', operation, status: 'running', result: null, error: null },
        logId: 'submit-log',
      }),
      getJob: async () => complete('android.performance.inspect', session(), 'wrong-job'),
    },
    { pollIntervalMs: 0 },
  );
  await assert.rejects(
    wrong.inspect(firstId, signal()),
    (error: unknown) =>
      error instanceof HostError &&
      error.code === 'invalid_performance_job' &&
      error.logId === 'query-log',
  );
  wrong.dispose();
});

test('同会话控制串行，第一项失败后队列仍允许 stop', async () => {
  const entered = deferred<void>();
  const pending = deferred<HostResult<Job>>();
  const calls: string[] = [];
  const consumer = createPerformance({
    submit: async (operation) => {
      calls.push(operation);
      if (operation.endsWith('.pause')) {
        entered.resolve();
        return pending.promise;
      }
      return complete(operation, session(firstId, 3, 'stopped'));
    },
    getJob: async () => {
      throw new Error('不应轮询');
    },
  });
  const pause = consumer.pause(firstId, signal());
  const failed = assert.rejects(pause, PerformanceJobFailure);
  const stop = consumer.stop(firstId, signal());
  await entered.promise;
  assert.deepEqual(calls, ['android.performance.pause']);
  pending.resolve({
    data: {
      id: 'job-pause',
      operation: 'android.performance.pause',
      status: 'failed',
      result: null,
      error: '原始失败',
    },
    logId: 'pause-log',
  });
  await failed;
  await stop;
  assert.deepEqual(calls, ['android.performance.pause', 'android.performance.stop']);
  consumer.dispose();
});

test('取消控制等待后不伪造停止、不重放，恢复前显式重查', async () => {
  const entered = deferred<void>();
  const pending = deferred<HostResult<Job>>();
  let pauseJob = false;
  let submits = 0;
  const consumer = createPerformance(
    {
      submit: async (operation) => {
        ++submits;
        if (operation.endsWith('.pause')) {
          pauseJob = true;
          return {
            data: { id: 'pause-job', operation, status: 'running', result: null, error: null },
            logId: 'submit-log',
          };
        }
        return complete(operation, session(firstId, 2, 'paused'));
      },
      getJob: async () => {
        assert.ok(pauseJob);
        entered.resolve();
        return pending.promise;
      },
    },
    { pollIntervalMs: 0 },
  );
  await consumer.select(firstId, signal());
  const cancellation = new AbortController();
  const pause = consumer.pause(firstId, cancellation.signal);
  const rejected = assert.rejects(
    pause,
    (error: unknown) =>
      error instanceof PerformanceWaitFailure &&
      error.job.id === 'pause-job' &&
      error.submitLogId === 'submit-log',
  );
  await entered.promise;
  cancellation.abort();
  await rejected;
  assert.equal(consumer.snapshot().session?.state, 'paused');
  assert.equal(consumer.snapshot().needsReconcile, true);
  await assert.rejects(
    consumer.resume(firstId, signal()),
    (error: unknown) =>
      error instanceof HostError && error.code === 'performance_reconcile_required',
  );
  assert.equal(submits, 2);
  pending.resolve(
    complete('android.performance.pause', session(firstId, 2, 'paused'), 'pause-job'),
  );
  await consumer.inspect(firstId, signal());
  assert.equal(consumer.snapshot().needsReconcile, false);
  consumer.dispose();
});

test('选择变化和销毁抑制忽略取消的晚响应，来源撤销保留历史与 stop', async () => {
  const entered = deferred<void>();
  const pending = deferred<HostResult<Job>>();
  let first = true;
  const calls: string[] = [];
  const consumer = createPerformance({
    submit: async (operation, input) => {
      calls.push(operation);
      if (first) {
        first = false;
        entered.resolve();
        return pending.promise;
      }
      const id =
        typeof input === 'object' &&
        input !== null &&
        !Array.isArray(input) &&
        input.session_id === secondId
          ? secondId
          : firstId;
      return complete(
        operation,
        operation.endsWith('.list')
          ? { sessions: [session()], next_after_id: firstId }
          : session(id, 2, 'stopped'),
      );
    },
    getJob: async () => {
      throw new Error('不应轮询');
    },
  });
  const old = consumer.select(firstId, signal());
  const rejected = assert.rejects(old);
  await entered.promise;
  await consumer.select(secondId, signal());
  await rejected;
  pending.resolve(complete('android.performance.inspect', session()));
  await Promise.resolve();
  assert.equal(consumer.snapshot().session?.id, secondId);
  consumer.invalidateSource();
  assert.equal(consumer.snapshot().session?.id, secondId);
  assert.equal(consumer.snapshot().liveAvailable, false);
  await assert.rejects(consumer.start(request, signal()));
  await assert.rejects(consumer.resume(secondId, signal()));
  await consumer.inspect(secondId, signal());
  await consumer.list({ limit: 1 }, signal());
  await consumer.stop(secondId, signal());
  let notices = 0;
  consumer.subscribe(() => {
    ++notices;
  });
  consumer.dispose();
  await assert.rejects(consumer.inspect(firstId, signal()));
  assert.equal(notices, 0);
  assert.equal(calls.includes('android.performance.start'), false);
});

test('修订与样本游标不回退，分页重试去重且 null 和缺省保持', async () => {
  let revision = 2;
  let badPage = false;
  let changedSource = false;
  const consumer = createPerformance(
    immediate((operation) => {
      const current = {
        ...session(firstId, revision, 'paused', 1),
        ...(changedSource
          ? {
              source: {
                plugin_id: 'synthetic',
                generation: 'new',
                operation: 'plugin.synthetic.sample',
              },
            }
          : {}),
      };
      if (operation.endsWith('.samples'))
        return {
          session: current,
          readings: [
            {
              sequence: 1,
              captured_at: 1001,
              pid: 1,
              logical_cpus: 2,
              cpu_share_percent: null,
              cpu_core_percent: null,
              pss_kib: 100,
              rss_kib: null,
            },
          ],
          next_after: badPage ? 0 : 1,
        };
      return current;
    }),
  );
  await consumer.select(firstId, signal());
  await consumer.samples(firstId, { after: 0, limit: 1 }, signal());
  await consumer.samples(firstId, { after: 0, limit: 1 }, signal());
  assert.equal(consumer.snapshot().readings.length, 1);
  assert.equal(consumer.snapshot().readings[0]?.cpu_share_percent, null);
  assert.equal(consumer.snapshot().readings[0]?.fps, undefined);
  assert.equal(consumer.snapshot().nextAfter, 1);
  badPage = true;
  await assert.rejects(consumer.samples(firstId, { after: 0, limit: 1 }, signal()));
  assert.equal(consumer.snapshot().nextAfter, 1);
  revision = 1;
  await assert.rejects(consumer.refresh(signal()));
  assert.equal(consumer.snapshot().session?.revision, 2);
  revision = 3;
  changedSource = true;
  await assert.rejects(
    consumer.refresh(signal()),
    (error: unknown) => error instanceof HostError && error.code === 'changed_performance_identity',
  );
  consumer.dispose();
});
