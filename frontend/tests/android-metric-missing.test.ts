import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeProfileIndex } from '../src/features/android-profile/index.ts';
import { isProfileMetrics } from '../src/features/android-profile/metrics.ts';
import type { ProfileDerived, ProfileMetrics, ProfileResult } from '../src/features/android-profile/types.ts';
import type { ProfileMetricMissing } from '../src/features/android-profile/types.ts';
import { isPerformancePage } from '../src/features/performance/results.ts';
import { ApiError } from '../src/shared/api/index.ts';
import { deviceObservation, observationReading } from './performance-observation-fixtures.ts';

const device = 'emulator-5554';
const cpuReason: NonNullable<ProfileMetricMissing['cpu']> = { source: 'linux.proc.stat', access: 'adb_shell', reason: 'permission_denied' };
const memoryReason: NonNullable<ProfileMetricMissing['memory']> = { source: 'android.dumpsys.meminfo', access: 'adb_shell', reason: 'unsupported' };
function diagnostic(cpu: boolean, memory: boolean): ProfileMetricMissing {
  return { api_version: 1, ...(cpu ? { cpu: cpuReason } : {}), ...(memory ? { memory: memoryReason } : {}) };
}
function metrics(overrides: Partial<ProfileMetrics> = {}): ProfileMetrics {
  return { captured_at: 1001, pid: 42, process_start_ticks: 900, process_ticks: 100, system_ticks: 1000, logical_cpus: 8,
    pss_kib: 200, rss_kib: 300, frame_window: { frames: 60, duration_ms: 1000, source: 'android.gfxinfo.framestats' },
    device_observation: deviceObservation(), ...overrides };
}
function missingMetrics(cpu: boolean, memory: boolean): ProfileMetrics {
  return metrics({ system_ticks: cpu ? null : 1000, logical_cpus: cpu ? null : 8, pss_kib: memory ? null : 200,
    rss_kib: memory ? null : 300, metric_missing: diagnostic(cpu, memory) });
}
function reading(cpu: boolean, memory: boolean) {
  return { ...observationReading(), logical_cpus: cpu ? null : 8, cpu_share_percent: cpu ? null : 5, cpu_core_percent: cpu ? null : 40,
    pss_kib: memory ? null : 200, rss_kib: memory ? null : 300, fps: 60,
    frame_window: { frames: 60, duration_ms: 1000, source: 'android.gfxinfo.framestats' }, metric_missing: diagnostic(cpu, memory) };
}
function page(readingValue: unknown) {
  return { session: { id: '11111111-1111-4111-8111-111111111111',
    request: { target: { device_id: device, package: 'com.example.app' }, interval_ms: 1000, duration_secs: 60 },
    state: 'running', revision: 1, samples: 1, started_at: 1000, updated_at: 1001, error: null }, readings: [readingValue], next_after: 1 };
}
function derived(overrides: Partial<ProfileDerived> = {}): ProfileDerived {
  return { api_version: 1, cpu_share_percent: 5, cpu_core_percent: 40, cpu_reason: null,
    fps: 60, fps_reason: null, battery_net_power_mw: -8000, battery_reason: null, ...overrides };
}
function missingCpu(): ProfileDerived {
  return derived({ cpu_share_percent: null, cpu_core_percent: null, cpu_reason: '系统 CPU 指标不可用或尚无连续基线' });
}
function sample(index: number, raw: unknown, values?: unknown) {
  const begin = String(index * 10); const end = String(index * 10 + 5);
  return { index, begin_ns: begin, end_ns: end, metrics: raw, ...(values === undefined ? {} : { derived: values }),
    frame: { index, filename: 'frames/' + String(index).padStart(6, '0') + '.png', begin_ns: begin, end_ns: end }, stack_sample_indices: [] };
}
function read(samples: readonly unknown[]) {
  const published: ProfileResult = { format_version: 1, device_id: device, package: 'com.example.game', pid: 42,
    process_start_ticks: '900', clock: 'boottime', frame_kind: 'sampled_screenshot', display_frame_complete: false,
    root_access: 'none', stack_status: 'unavailable', stack_reason: '设备没有 Root', sample_count: samples.length,
    stack_sample_count: 0, lost_count: '0', frame_count: samples.length, index_filename: 'profile-index.json', archive_filename: 'profile.zip' };
  const { sample_count, frame_count, index_filename, archive_filename, ...identity } = published;
  assert.equal(sample_count, frame_count); assert.ok(index_filename && archive_filename);
  return decodeProfileIndex({ ...identity, samples, symbolication: 'reported_symbols_only' }, published, 'partial-metrics-log');
}
const protocolLog = (error: unknown) => error instanceof ApiError && error.kind === 'protocol' && error.logId === 'partial-metrics-log';

test('健康旧页与旧档案兼容RSS省略或null，缺测诊断省略或显式null不反填', () => {
  const legacyRaw = metrics(); const legacyReading = observationReading();
  const { rss_kib: rawRss, ...rawWithoutRss } = legacyRaw;
  const { rss_kib: readingRss, ...readingWithoutRss } = legacyReading;
  assert.equal(rawRss, 300); assert.equal(readingRss, null);
  for (const value of [legacyRaw, rawWithoutRss, { ...legacyRaw, rss_kib: null }, { ...legacyRaw, metric_missing: null }]) {
    assert.ok(isProfileMetrics(value, device)); assert.deepEqual(read([sample(0, value)]).samples[0]?.metrics, value);
  }
  for (const value of [legacyReading, readingWithoutRss, { ...legacyReading, metric_missing: null }]) assert.ok(isPerformancePage(page(value)));
  assert.equal(Object.hasOwn(rawWithoutRss, 'rss_kib'), false);
  assert.equal(Object.hasOwn(legacyRaw, 'metric_missing'), false);
});

test('CPU与内存可各自缺测或同时缺测，保留原FPS、环境、窗口及归档帧', () => {
  for (const [cpu, memory] of [[true, false], [false, true], [true, true]]) {
    assert.equal(typeof cpu, 'boolean'); assert.equal(typeof memory, 'boolean');
    if (cpu === undefined || memory === undefined) throw new Error('缺测矩阵缺少维度');
    const raw = missingMetrics(cpu, memory); const sessionReading = reading(cpu, memory);
    const original = JSON.stringify({ raw, sessionReading });
    assert.ok(isProfileMetrics(raw, device)); assert.ok(isPerformancePage(page(sessionReading)));
    const accepted = read([sample(0, raw, missingCpu())]).samples[0]; assert.ok(accepted);
    assert.equal(accepted.derived?.fps, 60); assert.equal(accepted.derived?.battery_net_power_mw, -8000);
    assert.equal(accepted.metrics, raw); assert.equal(sessionReading.fps, 60);
    assert.deepEqual(accepted.metrics.frame_window, raw.frame_window); assert.deepEqual(accepted.metrics.device_observation, raw.device_observation);
    assert.equal(accepted.frame?.filename, 'frames/000000.png'); assert.equal(sessionReading.battery_net_power_mw, -8000);
    assert.equal(raw.pss_kib, memory ? null : 200); assert.equal(raw.process_ticks, 100);
    assert.equal(JSON.stringify({ raw, sessionReading }), original);
  }
});

test('缺测对象允许省略或null的健康项，保留Root通道与稳定来源边界', () => {
  const cpu = missingMetrics(true, false); const memory = missingMetrics(false, true);
  for (const source of ['x', 'x'.repeat(80)]) {
    const cpuDiagnostic = { api_version: 1, cpu: { ...cpuReason, source }, memory: null };
    assert.ok(isProfileMetrics({ ...cpu, metric_missing: cpuDiagnostic }, device));
    assert.ok(isPerformancePage(page({ ...reading(true, false), metric_missing: cpuDiagnostic })));
  }
  const memoryDiagnostic = { api_version: 1, cpu: null, memory: { ...memoryReason, access: 'root_shell', reason: 'permission_denied' } };
  assert.ok(isProfileMetrics({ ...memory, metric_missing: memoryDiagnostic }, device));
  assert.ok(isPerformancePage(page({ ...reading(false, true), metric_missing: memoryDiagnostic })));
});

test('缺测诊断拒绝空容器、未知版本字段、非法来源权限原因和缺少诊断', () => {
  const invalid: unknown[] = [undefined, null, {}, [], { api_version: 1 }, { api_version: 1, cpu: null, memory: null },
    { cpu: cpuReason }, { api_version: 2, cpu: cpuReason }, { api_version: 1, cpu: cpuReason, extra: true },
    { api_version: 1, cpu: [] }, { api_version: 1, cpu: { ...cpuReason, extra: true } },
    { api_version: 1, cpu: { access: 'adb_shell', reason: 'permission_denied' } },
    ...['', 'x'.repeat(81), '来源', 'linux proc stat', 'linux/proc/stat', 'linux.proc.stat\n'].map((source) => ({ api_version: 1, cpu: { ...cpuReason, source } })),
    { api_version: 1, cpu: { ...cpuReason, access: 'unknown' } }, { api_version: 1, cpu: { ...cpuReason, reason: 'timeout' } }];
  for (const metric_missing of invalid) {
    const raw = { ...missingMetrics(true, false), metric_missing };
    assert.equal(isProfileMetrics(raw, device), false);
    assert.equal(isPerformancePage(page({ ...reading(true, false), metric_missing })), false);
    assert.throws(() => read([sample(0, raw)]), protocolLog);
  }
  for (const metric_missing of [{}, { api_version: 1 }, { api_version: 1, cpu: null, memory: null }]) {
    assert.equal(isProfileMetrics({ ...metrics(), metric_missing }, device), false);
    assert.equal(isPerformancePage(page({ ...observationReading(), metric_missing })), false);
  }
});

test('原始值与缺测原因必须双向吻合，拒绝单边空值及非明确null', () => {
  const cpu = missingMetrics(true, false); const memory = missingMetrics(false, true);
  const invalidRaw: unknown[] = [{ ...metrics(), metric_missing: diagnostic(true, false) }, { ...metrics(), metric_missing: diagnostic(false, true) },
    { ...cpu, system_ticks: 1000 }, { ...cpu, logical_cpus: 8 }, { ...cpu, system_ticks: undefined },
    { ...cpu, logical_cpus: undefined }, { ...memory, pss_kib: 0 }, { ...memory, rss_kib: 0 },
    { ...memory, pss_kib: undefined }, { ...memory, rss_kib: undefined },
    { ...cpu, metric_missing: diagnostic(false, true) }, { ...memory, metric_missing: diagnostic(true, false) }];
  for (const value of invalidRaw) assert.equal(isProfileMetrics(value, device), false);
  const cpuReading = reading(true, false); const memoryReading = reading(false, true);
  const invalidReading: unknown[] = [{ ...observationReading(), metric_missing: diagnostic(true, false) },
    { ...cpuReading, logical_cpus: 8 }, { ...cpuReading, logical_cpus: undefined },
    { ...cpuReading, cpu_share_percent: 0 }, { ...cpuReading, cpu_core_percent: 0 },
    { ...cpuReading, cpu_share_percent: undefined }, { ...cpuReading, cpu_core_percent: undefined },
    { ...memoryReading, pss_kib: 0 }, { ...memoryReading, rss_kib: 0 }, { ...memoryReading, rss_kib: undefined },
    { ...cpuReading, metric_missing: diagnostic(false, true) }];
  for (const value of invalidReading) assert.equal(isPerformancePage(page(value)), false);
});

test('独立缺测不放宽身份、进程计数、有效内存、时间、帧和设备观测资格', () => {
  const cpu = missingMetrics(true, false);
  for (const value of [{ ...cpu, pid: 0 }, { ...cpu, process_start_ticks: -1 }, { ...cpu, process_ticks: null },
    { ...cpu, process_ticks: -1 }, { ...cpu, process_ticks: NaN }, { ...cpu, captured_at: Infinity },
    { ...cpu, pss_kib: NaN }, { ...cpu, rss_kib: -1 }, { ...cpu, fps: 60 },
    { ...cpu, frame_window: { frames: 60, duration_ms: 0, source: 'android.gfxinfo.framestats' } },
    { ...cpu, device_observation: { ...deviceObservation(), device_id: 'other-device' } }]) assert.equal(isProfileMetrics(value, device), false);
  for (const value of [{ ...reading(true, false), pid: 0 }, { ...reading(true, false), fps: Infinity },
    { ...reading(true, false), pss_kib: -1 }, { ...reading(true, false), captured_at: -1 },
    { ...reading(true, false), frame_window: { frames: 60, duration_ms: 0, source: 'android.gfxinfo.framestats' } }]) {
    assert.equal(isPerformancePage(page(value)), false);
  }
  assert.throws(() => read([sample(0, { ...cpu, pid: 43 })]), protocolLog);
});

test('有效到缺测再恢复的相邻CPU基线中断，恢复首样为空而下一有效样本恢复', () => {
  const a = metrics();
  const b = { ...missingMetrics(true, false), captured_at: 2001, process_ticks: 150 };
  const c = metrics({ captured_at: 3001, process_ticks: 200, system_ticks: 3000 });
  const d = metrics({ captured_at: 4001, process_ticks: 250, system_ticks: 4000 });
  const samples = [sample(0, a, missingCpu()), sample(1, b, missingCpu()), sample(2, c, missingCpu()), sample(3, d, derived())];
  const accepted = read(samples);
  assert.deepEqual(accepted.samples.map((value) => value.derived?.cpu_share_percent), [null, null, null, 5]);
  assert.deepEqual(accepted.samples.map((value) => value.derived?.cpu_core_percent), [null, null, null, 40]);
  for (const value of accepted.samples) {
    assert.equal(value.derived?.fps, 60); assert.equal(value.derived?.battery_net_power_mw, -8000);
    assert.equal(value.metrics.pss_kib, 200); assert.deepEqual(value.metrics.frame_window, a.frame_window);
    assert.ok(value.frame); assert.equal(Object.keys(value.derived ?? {}).length, 8);
  }
  assert.throws(() => read([samples[0], sample(1, b, derived())]), protocolLog);
  assert.throws(() => read([samples[0], samples[1], sample(2, c, derived())]), protocolLog);
  assert.throws(() => read([samples[0], samples[1], sample(2, c, { ...missingCpu(), cpu_core_percent: 0 })]), protocolLog);
});

test('只有内存缺测时CPU连续差分仍可消费，FPS电池及帧保持合格原值', () => {
  const previous = metrics();
  const current = { ...missingMetrics(false, true), captured_at: 2001, process_ticks: 150, system_ticks: 2000 };
  const accepted = read([sample(0, previous, missingCpu()), sample(1, current, derived())]).samples[1];
  assert.ok(accepted); assert.equal(accepted.metrics.pss_kib, null); assert.equal(accepted.metrics.rss_kib, null);
  assert.equal(accepted.derived?.cpu_share_percent, 5); assert.equal(accepted.derived?.cpu_core_percent, 40);
  assert.equal(accepted.derived?.fps, 60); assert.equal(accepted.derived?.battery_net_power_mw, -8000);
  assert.equal(accepted.frame?.filename, 'frames/000001.png');
});
