import assert from 'node:assert/strict';
import test from 'node:test';
import { createPerformance } from '../src/features/performance/index.ts';
import type { PerformanceGateway } from '../src/features/performance/index.ts';
import { createFrontendRuntime } from '../src/app/index.ts';
import { HostError } from '../src/plugin-sdk/index.ts';
import type { HostResult, Job, JsonValue } from '../src/plugin-sdk/index.ts';
import { requestUrl, signal, success } from './fixtures.ts';

const sessionId = '11111111-1111-4111-8111-111111111111';
const request = {
  target: { device_id: 'emulator-5554', package: 'com.example.game' },
  interval_ms: 1000,
  duration_secs: 60,
};
const source = {
  plugin_id: 'android-device',
  generation: 'generation-1',
  operation: 'plugin.android-device.performance.sample',
  device: { provider_id: 'android-device', generation: 'generation-1', local_id: 'emulator-5554' },
};
function session(revision = 1, state = 'running', samples = 0): { [key: string]: JsonValue } {
  return {
    id: sessionId,
    request,
    source,
    revision,
    state,
    samples,
    started_at: 1000,
    updated_at: 1000 + revision,
    error: null,
  };
}
function reading(sequence: number): { [key: string]: JsonValue } {
  return {
    sequence,
    captured_at: 1000 + sequence,
    pid: 1,
    logical_cpus: 8,
    cpu_share_percent: null,
    cpu_core_percent: null,
    pss_kib: 100,
    rss_kib: null,
  };
}
function completed(operation: string, result: JsonValue): HostResult<Job> {
  return {
    data: { id: 'fps-job', operation, status: 'succeeded', result, error: null },
    logId: 'fps-result-log',
  };
}
function gateway(respond: (operation: string, input: JsonValue) => JsonValue): PerformanceGateway {
  return {
    submit: async (operation, input) => completed(operation, respond(operation, input)),
    getJob: async () => {
      throw new Error('成功终态不得再次查询任务');
    },
  };
}

test('公开性能服务保留FPS缺省、null、有效零和毫秒窗口，不因能力true补值', async () => {
  const readings = [
    reading(1),
    { ...reading(2), fps: null, frame_window: null },
    {
      ...reading(3),
      fps: 0,
      frame_window: { frames: 0, duration_ms: 1000, source: 'synthetic_zero' },
    },
    {
      ...reading(4),
      fps: 60000 / 1001,
      frame_window: { frames: 60, duration_ms: 1001, source: 'sf_present_aaaaaaaaaaaaaaaa' },
    },
  ];
  const current = session(1, 'running', readings.length);
  const page = { session: current, readings, next_after: readings.length };
  const calls: string[] = [];
  const runtime = createFrontendRuntime({
    baseUrl: 'http://localhost:7031',
    panelTarget: () => null,
    transport: async (input, init) => {
      assert.equal(requestUrl(input).pathname, '/api/v2/jobs');
      assert.equal(init?.method, 'POST');
      const body: unknown = JSON.parse(String(init.body));
      assert.ok(
        typeof body === 'object' &&
          body !== null &&
          'operation' in body &&
          typeof body.operation === 'string',
      );
      calls.push(body.operation);
      const result = body.operation.endsWith('.capabilities')
        ? {
            metrics: ['cpu_share_percent', 'cpu_core_percent', 'pss_kib', 'rss_kib', 'fps'],
            fps: true,
            source: 'plugin.android-device',
            scope: 'main_process',
            max_samples: 3600,
            sample_timeout_ms: 10000,
          }
        : body.operation.endsWith('.samples')
          ? page
          : current;
      return success(
        {
          id: 'fps-service-job',
          operation: body.operation,
          input: {},
          created_at: 1,
          status: 'succeeded',
          result,
        },
        'fps-service-log',
      );
    },
  });
  try {
    const extensions = runtime.host.extensions;
    assert.ok(extensions);
    const capability = await extensions.callService(
      'host.performance',
      '1',
      { action: 'capabilities' },
      signal(),
    );
    assert.ok(
      capability.data !== null &&
        typeof capability.data === 'object' &&
        !Array.isArray(capability.data),
    );
    assert.equal(capability.data.fps, true);
    await runtime.performance.select(sessionId, signal());
    const response = await extensions.callService(
      'host.performance',
      '1',
      { action: 'samples', input: { session_id: sessionId, after: 0, limit: 4 } },
      signal(),
    );
    assert.equal(response.logId, 'fps-service-log');
    assert.deepEqual(response.data, page);
    const accepted = runtime.performance.snapshot().readings;
    assert.equal(Object.hasOwn(accepted[0] ?? {}, 'fps'), false);
    assert.equal(Object.hasOwn(accepted[0] ?? {}, 'frame_window'), false);
    assert.equal(accepted[1]?.fps, null);
    assert.equal(accepted[1]?.frame_window, null);
    assert.equal(accepted[2]?.fps, 0);
    assert.equal(accepted[2]?.frame_window?.frames, 0);
    assert.equal(accepted[3]?.fps, 60000 / 1001);
    assert.equal(accepted[3]?.frame_window?.duration_ms, 1001);
    assert.deepEqual(calls, [
      'android.performance.capabilities',
      'android.performance.inspect',
      'android.performance.samples',
    ]);
  } finally {
    await runtime.dispose();
  }
});

test('CPU首样本缺测不覆盖合法FPS，暂停恢复后的FPS缺测不沿用旧窗口', async () => {
  let revision = 1;
  let state = 'running';
  let resumed = false;
  const before = {
    ...reading(1),
    fps: 60,
    frame_window: { frames: 60, duration_ms: 1000, source: 'sf_present_aaaaaaaaaaaaaaaa' },
  };
  const after = { ...reading(2), fps: null, frame_window: null };
  const consumer = createPerformance(
    gateway((operation) => {
      if (operation.endsWith('.pause')) {
        revision = 2;
        state = 'paused';
      }
      if (operation.endsWith('.resume')) {
        revision = 3;
        state = 'running';
        resumed = true;
      }
      const current = session(revision, state, resumed ? 2 : 1);
      return operation.endsWith('.samples')
        ? { session: current, readings: resumed ? [after] : [before], next_after: resumed ? 2 : 1 }
        : current;
    }),
  );
  try {
    await consumer.select(sessionId, signal());
    await consumer.samples(sessionId, { after: 0, limit: 1 }, signal());
    assert.equal(consumer.snapshot().readings[0]?.cpu_share_percent, null);
    assert.equal(consumer.snapshot().readings[0]?.fps, 60);
    await consumer.pause(sessionId, signal());
    assert.equal(consumer.snapshot().session?.state, 'paused');
    assert.equal(consumer.snapshot().readings[0]?.fps, 60);
    await consumer.resume(sessionId, signal());
    await consumer.samples(sessionId, { after: 1, limit: 1 }, signal());
    assert.equal(consumer.snapshot().readings.length, 2);
    assert.equal(consumer.snapshot().readings[0]?.frame_window?.frames, 60);
    assert.equal(consumer.snapshot().readings[1]?.fps, null);
    assert.equal(consumer.snapshot().readings[1]?.frame_window, null);
  } finally {
    consumer.dispose();
  }
});

test('逐样本保留窗口来源和重叠数量，不把同会话不同展示源累加或替换', async () => {
  const rows = [
    {
      ...reading(1),
      fps: 30,
      frame_window: { frames: 30, duration_ms: 1000, source: 'sf_present_aaaaaaaaaaaaaaaa' },
    },
    {
      ...reading(2),
      fps: 40,
      frame_window: { frames: 60, duration_ms: 1500, source: 'sf_present_bbbbbbbbbbbbbbbb' },
    },
    reading(3),
  ];
  const current = session(1, 'running', rows.length);
  const consumer = createPerformance(
    gateway((operation) =>
      operation.endsWith('.samples')
        ? { session: current, readings: rows, next_after: rows.length }
        : current,
    ),
  );
  try {
    await consumer.select(sessionId, signal());
    await consumer.samples(sessionId, { after: 0, limit: 3 }, signal());
    const accepted = consumer.snapshot().readings;
    assert.equal(accepted[0]?.frame_window?.source, 'sf_present_aaaaaaaaaaaaaaaa');
    assert.equal(accepted[1]?.frame_window?.source, 'sf_present_bbbbbbbbbbbbbbbb');
    assert.equal(accepted[1]?.frame_window?.frames, 60);
    assert.equal(accepted[1]?.frame_window?.duration_ms, 1500);
    assert.equal(accepted[1]?.fps, 40);
    assert.equal(Object.hasOwn(accepted[2] ?? {}, 'fps'), false);
    await consumer.samples(sessionId, { after: 0, limit: 3 }, signal());
    assert.equal(consumer.snapshot().readings.length, 3);
    assert.equal(consumer.snapshot().nextAfter, 3);
  } finally {
    consumer.dispose();
  }
});

test('同会话采样插件换代被拒绝，旧FPS历史和游标保持原归属', async () => {
  let changed = false;
  const original = {
    ...reading(1),
    fps: 30,
    frame_window: { frames: 30, duration_ms: 1000, source: 'sf_present_aaaaaaaaaaaaaaaa' },
  };
  const consumer = createPerformance(
    gateway((operation) => {
      const current = {
        ...session(changed ? 2 : 1, 'running', 1),
        source: changed
          ? {
              ...source,
              generation: 'generation-2',
              device: { ...source.device, generation: 'generation-2' },
            }
          : source,
      };
      return operation.endsWith('.samples')
        ? { session: current, readings: [original], next_after: 1 }
        : current;
    }),
  );
  try {
    await consumer.select(sessionId, signal());
    await consumer.samples(sessionId, { after: 0, limit: 1 }, signal());
    changed = true;
    await assert.rejects(
      consumer.inspect(sessionId, signal()),
      (error: unknown) =>
        error instanceof HostError && error.code === 'changed_performance_identity',
    );
    assert.equal(consumer.snapshot().session?.source?.generation, 'generation-1');
    assert.equal(consumer.snapshot().readings[0]?.fps, 30);
    assert.equal(consumer.snapshot().nextAfter, 1);
  } finally {
    consumer.dispose();
  }
});

test('来源下线后的已完成历史仍可读，旧记录不补来源、FPS或帧窗口', async () => {
  const { source: currentSource, ...legacy } = session(1, 'completed', 2);
  assert.ok(currentSource);
  const rows = [reading(1), { ...reading(2), fps: null, frame_window: null }];
  const calls: string[] = [];
  const consumer = createPerformance(
    gateway((operation) => {
      calls.push(operation);
      if (operation.endsWith('.samples')) return { session: legacy, readings: rows, next_after: 2 };
      if (operation.endsWith('.list')) return { sessions: [legacy], next_after_id: sessionId };
      return legacy;
    }),
  );
  try {
    consumer.invalidateSource();
    await consumer.select(sessionId, signal());
    const page = await consumer.samples(sessionId, { after: 0, limit: 2 }, signal());
    await consumer.list({ limit: 1 }, signal());
    assert.equal(consumer.snapshot().liveAvailable, false);
    assert.equal(Object.hasOwn(page.data.session, 'source'), false);
    assert.equal(Object.hasOwn(page.data.readings[0] ?? {}, 'fps'), false);
    assert.equal(Object.hasOwn(page.data.readings[0] ?? {}, 'frame_window'), false);
    assert.equal(page.data.readings[1]?.fps, null);
    assert.equal(page.data.readings[1]?.frame_window, null);
    assert.throws(
      () => consumer.capabilities(signal()),
      (error: unknown) => error instanceof HostError && error.kind === 'cancelled',
    );
    assert.deepEqual(calls, [
      'android.performance.inspect',
      'android.performance.samples',
      'android.performance.list',
    ]);
  } finally {
    consumer.dispose();
  }
});

test('FPS独立范围为0至1000，旧历史可单独保留FPS或窗口，超界拒绝并保留日志', async () => {
  const current = session(1, 'completed', 3);
  const legacyRows = [
    { ...reading(1), fps: 0 },
    { ...reading(2), fps: 1000 },
    { ...reading(3), frame_window: { frames: 1, duration_ms: 1, source: 'legacy_window' } },
  ];
  let invalid = false;
  const consumer = createPerformance(
    gateway((operation) =>
      operation.endsWith('.samples')
        ? {
            session: current,
            readings: invalid ? [{ ...reading(1), fps: 1001 }] : legacyRows,
            next_after: invalid ? 1 : 3,
          }
        : current,
    ),
  );
  try {
    await consumer.select(sessionId, signal());
    const accepted = await consumer.samples(sessionId, { after: 0, limit: 3 }, signal());
    assert.equal(accepted.data.readings[0]?.fps, 0);
    assert.equal(accepted.data.readings[1]?.fps, 1000);
    assert.equal(Object.hasOwn(accepted.data.readings[0] ?? {}, 'frame_window'), false);
    assert.equal(Object.hasOwn(accepted.data.readings[1] ?? {}, 'frame_window'), false);
    assert.equal(Object.hasOwn(accepted.data.readings[2] ?? {}, 'fps'), false);
    assert.equal(accepted.data.readings[2]?.frame_window?.duration_ms, 1);
    invalid = true;
    await assert.rejects(
      consumer.samples(sessionId, { after: 0, limit: 3 }, signal()),
      (error: unknown) =>
        error instanceof HostError &&
        error.code === 'invalid_performance_result' &&
        error.logId === 'fps-result-log',
    );
    assert.equal(consumer.snapshot().nextAfter, 3);
    assert.equal(consumer.snapshot().readings.length, 3);
    assert.equal(consumer.snapshot().readings[1]?.fps, 1000);
  } finally {
    consumer.dispose();
  }
});
