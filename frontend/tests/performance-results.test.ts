import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodePerformanceCapabilities,
  isPerformancePage,
  isPerformanceSession,
  isPerformanceSessions,
  isPerformanceStart,
  requireSession,
} from '../src/features/performance/utils/results.ts';
import { HostError } from '../src/plugin-sdk/index.ts';

const id = '11111111-1111-4111-8111-111111111111';
function session() {
  return {
    id,
    request: {
      target: { device_id: 'emulator-5554', package: 'com.example.app' },
      interval_ms: 1000,
      duration_secs: 60,
    },
    state: 'running',
    revision: 1,
    samples: 1,
    started_at: 1000,
    updated_at: 1001,
    error: null,
  };
}
const source = {
  plugin_id: 'android-device',
  generation: 'generation-1',
  operation: 'plugin.android-device.performance.sample',
  device: { provider_id: 'android-device', generation: 'generation-1', local_id: 'emulator-5554' },
};
function reading() {
  return {
    sequence: 1,
    captured_at: 1001,
    pid: 1,
    logical_cpus: 8,
    cpu_share_percent: null,
    cpu_core_percent: null,
    pss_kib: 100,
    rss_kib: null,
  };
}
function capabilities() {
  return {
    metrics: ['cpu_share_percent', 'cpu_core_percent', 'pss_kib', 'rss_kib'],
    fps: false,
    source: 'plugin.android-device',
    scope: 'main_process',
    max_samples: 3600,
    sample_timeout_ms: 10000,
  };
}

test('会话校验接受原缺省、真实 null 和不可变当代来源，不反填字段', () => {
  const legacy = session();
  assert.ok(isPerformanceSession(legacy));
  assert.equal('source' in legacy, false);
  const nullable = { ...session(), source: null };
  assert.ok(isPerformanceSession(nullable));
  assert.equal(nullable.source, null);
  const current = { ...session(), source };
  assert.ok(isPerformanceSession(current));
  assert.equal(current.source, source);
  const synthetic = {
    ...session(),
    source: {
      plugin_id: 'synthetic',
      generation: 'generation-2',
      operation: 'plugin.synthetic.sample',
    },
  };
  assert.ok(isPerformanceSession(synthetic));
  assert.equal('device' in synthetic.source, false);
  assert.ok(isPerformanceSessions({ sessions: [legacy], next_after_id: id }));
});

test('性能结果拒绝 sample 封套、坏身份、非法值和跨提供者绑定', () => {
  for (const value of [
    null,
    { result: session(), artifacts: [] },
    { ...session(), id: 'job-id' },
    { ...session(), state: 'draining' },
    { ...session(), revision: -1 },
    { ...session(), samples: 3601 },
    { ...session(), updated_at: 999 },
    { ...session(), source: { ...source, generation: 2 } },
    { ...session(), source: { ...source, device: { ...source.device, provider_id: 'other' } } },
    {
      ...session(),
      source: { ...source, device: { ...source.device, generation: 'generation-2' } },
    },
    { ...session(), source: { ...source, device: { ...source.device, local_id: 'other-device' } } },
    { ...session(), source: { ...source, operation: 'plugin.other.sample' } },
  ])
    assert.equal(isPerformanceSession(value), false);
  assert.throws(
    () => requireSession(session(), 'log-result', '22222222-2222-4222-8222-222222222222'),
    (error: unknown) =>
      error instanceof HostError && error.kind === 'protocol' && error.logId === 'log-result',
  );
  assert.equal(
    isPerformanceSessions({ sessions: [session(), session()], next_after_id: null }),
    false,
  );
});

test('创建参数遵守旧 ASCII 设备标识与 Android 包名，不扩张输入资格', () => {
  assert.ok(
    isPerformanceStart({
      ...session().request,
      target: { device_id: '[::1]:5555', package: '_com._app' },
    }),
  );
  for (const request of [
    { ...session().request, interval_ms: 999 },
    { ...session().request, duration_secs: 3601 },
    { ...session().request, target: { device_id: '-device', package: 'com.app' } },
    { ...session().request, target: { device_id: 'device', package: 'com.1app' } },
  ])
    assert.equal(isPerformanceStart(request), false);
});

test('样本页保留 CPU/FPS/RSS 缺测与零，拒绝倒序、重复和超出会话计数', () => {
  const missing = reading();
  const page = { session: session(), readings: [missing], next_after: 1 };
  assert.ok(isPerformancePage(page));
  assert.equal(missing.cpu_share_percent, null);
  assert.equal('fps' in missing, false);
  const zero = {
    ...reading(),
    fps: 0,
    frame_window: { duration_ms: 1000, frames: 0, source: 'synthetic' },
    cpu_share_percent: 0,
    cpu_core_percent: 0,
    rss_kib: 0,
  };
  assert.ok(isPerformancePage({ ...page, readings: [zero] }));
  assert.equal(zero.fps, 0);
  assert.ok(
    isPerformancePage({ ...page, readings: [{ ...reading(), fps: null, frame_window: null }] }),
  );
  for (const invalid of [
    { ...page, readings: [reading(), reading()] },
    { ...page, next_after: 0 },
    { ...page, readings: [{ ...reading(), sequence: 2 }], next_after: 2 },
    { ...page, readings: [{ ...reading(), cpu_share_percent: NaN }] },
    { ...page, readings: [{ ...reading(), cpu_share_percent: 101 }] },
    { ...page, readings: [{ ...reading(), pid: 0 }] },
    {
      ...page,
      readings: [{ ...reading(), frame_window: { duration_ms: 0, frames: 1, source: 'bad' } }],
    },
  ])
    assert.equal(isPerformancePage(invalid), false);
});

test('能力响应只映射已校验的实际字段，来源标签不充当设备引用', () => {
  const decoded = decodePerformanceCapabilities(capabilities(), 'cap-log');
  assert.equal(decoded.sourceLabel, 'plugin.android-device');
  assert.equal(decoded.maxSamples, 3600);
  const fps = decodePerformanceCapabilities(
    { ...capabilities(), fps: true, metrics: [...capabilities().metrics, 'fps'] },
    null,
  );
  assert.equal(fps.fps, true);
  for (const value of [
    { result: capabilities(), artifacts: [] },
    { ...capabilities(), fps: true },
    { ...capabilities(), max_samples: 0 },
    {
      ...capabilities(),
      metrics: ['cpu_share_percent', 'cpu_share_percent', 'pss_kib', 'rss_kib'],
    },
  ]) {
    assert.throws(
      () => decodePerformanceCapabilities(value, 'cap-log'),
      (error: unknown) => error instanceof HostError && error.logId === 'cap-log',
    );
  }
});
