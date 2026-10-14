import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeProfileIndex } from '../src/features/android-profile/index.ts';
import type { ProfileDerived, ProfileMetrics, ProfileResult, ProfileSample } from '../src/features/android-profile/index.ts';
import { ApiError } from '../src/services/api/index.ts';

const device = 'emulator-5554';
function metrics(overrides: Partial<ProfileMetrics> = {}): ProfileMetrics {
  return { captured_at: 2000, pid: 42, process_start_ticks: 900, process_ticks: 150, system_ticks: 2000, logical_cpus: 8, pss_kib: 200,
    frame_window: { frames: 60, duration_ms: 1000, source: 'android.gfxinfo.framestats' },
    device_observation: { api_version: 1, scope: 'device', device_id: device, temperatures: [],
      battery: { observed_at: 2000, source: 'linux.power_supply.battery', access: 'adb_shell', voltage_uv: 4000000,
        current_ua: -2000000, current_polarity: 'positive_charging', status: 'discharging', supply_state: 'battery' } }, ...overrides };
}
function baseline(overrides: Partial<ProfileMetrics> = {}): ProfileMetrics {
  return metrics({ captured_at: 1000, process_ticks: 100, system_ticks: 1000, frame_window: null, device_observation: null, ...overrides });
}
function derived(overrides: Partial<ProfileDerived> = {}): ProfileDerived {
  return { api_version: 1, cpu_share_percent: 5, cpu_core_percent: 40, cpu_reason: null,
    fps: 60, fps_reason: null, battery_net_power_mw: -8000, battery_reason: null, ...overrides };
}
function result(sampleCount: number): ProfileResult {
  return { format_version: 1, device_id: device, package: 'com.example.game', pid: 42, process_start_ticks: '900', clock: 'boottime',
    frame_kind: 'sampled_screenshot', display_frame_complete: false, root_access: 'none', stack_status: 'unavailable', stack_reason: '设备没有 Root',
    sample_count: sampleCount, stack_sample_count: 0, lost_count: '0', frame_count: 0, index_filename: 'profile-index.json', archive_filename: 'profile.zip' };
}
function sample(index: number, current: ProfileMetrics): ProfileSample {
  return { index, begin_ns: String(index * 10), end_ns: String(index * 10 + 5), metrics: current, frame: null, stack_sample_indices: [] };
}
function read(samples: readonly unknown[]) {
  const published = result(samples.length);
  const { sample_count, frame_count, index_filename, archive_filename, ...identity } = published;
  assert.ok(sample_count >= 0 && frame_count === 0 && index_filename && archive_filename);
  return decodeProfileIndex({ ...identity, symbolication: 'reported_symbols_only', samples }, published, 'derived-log');
}
function consume(value: unknown, current = metrics(), previous = baseline()) {
  return read([sample(0, previous), { ...sample(1, current), derived: value }]);
}
function protocolLog(error: unknown): boolean {
  return error instanceof ApiError && error.kind === 'protocol' && error.logId === 'derived-log';
}
function rejected(value: unknown, current = metrics(), previous = baseline()) {
  assert.throws(() => consume(value, current, previous), protocolLog);
}

test('旧索引缺少派生对象时保持原计数，不增加相邻差分资格或反填字段', () => {
  const current = baseline({ process_ticks: 1, system_ticks: 1 });
  const accepted = read([sample(0, baseline()), sample(1, current)]);
  assert.equal(accepted.samples[1]?.metrics, current);
  assert.equal(Object.hasOwn(accepted.samples[1] ?? {}, 'derived'), false);
  assert.equal(Object.hasOwn(current, 'cpu_share_percent'), false);
});

test('新派生对象与原指标分别原样保留，首点CPU缺测不清空合格FPS和功率', () => {
  const values = derived(); const current = metrics();
  const accepted = consume(values, current);
  assert.equal(accepted.samples[1]?.derived, values); assert.equal(accepted.samples[1]?.metrics, current);
  const first = derived({ cpu_share_percent: null, cpu_core_percent: null, cpu_reason: '缺少前一个 CPU 样本' });
  assert.equal(read([{ ...sample(0, current), derived: first }]).samples[0]?.derived?.fps, 60);
  assert.equal(Object.hasOwn(current, 'battery_net_power_mw'), false);
});

test('派生对象只接受精确v1字段，拒绝空对象、未知版本、缺字段和额外字段', () => {
  const values = derived(); const { battery_reason, ...incomplete } = values; assert.equal(battery_reason, null);
  for (const value of [null, {}, [], { ...values, api_version: 2 }, { ...values, extra: 1 }, incomplete,
    { ...values, cpu_reason: undefined }, { ...values, fps_reason: undefined }, { ...values, battery_reason: undefined }]) rejected(value);
});

test('CPU百分比成对且按核数成比例，拒绝非有限值、越界和有值时的缺测原因', () => {
  for (const value of [{ ...derived(), cpu_share_percent: null }, { ...derived(), cpu_core_percent: null },
    derived({ cpu_share_percent: NaN }), derived({ cpu_core_percent: Infinity }), derived({ cpu_share_percent: -1, cpu_core_percent: -8 }),
    derived({ cpu_share_percent: 101, cpu_core_percent: 808 }), derived({ cpu_share_percent: 100, cpu_core_percent: 801 }),
    derived({ cpu_core_percent: 5 }), derived({ cpu_reason: '仍有读数' })]) rejected(value);
  assert.ok(consume(derived({ cpu_share_percent: 100, cpu_core_percent: 800 })));
});

test('CPU有值需要有效相邻基线，缺测可保留零差分、回退和核数变化的原因', () => {
  const values = derived(); const current = metrics();
  assert.throws(() => read([{ ...sample(0, current), derived: values }]), protocolLog);
  for (const previous of [baseline({ captured_at: 2000 }), baseline({ captured_at: 2001 }), baseline({ system_ticks: 2000 }),
    baseline({ system_ticks: 2100 }), baseline({ process_ticks: 151 }), baseline({ logical_cpus: 4 })]) rejected(values, current, previous);
  rejected(values, metrics({ process_ticks: 1101 }));
  const missing = derived({ cpu_share_percent: null, cpu_core_percent: null, cpu_reason: '计数或核数变化' });
  assert.ok(consume(missing, current, baseline({ logical_cpus: 4 })));
  assert.ok(consume(derived({ cpu_share_percent: 0, cpu_core_percent: 0 }), metrics({ process_ticks: 100 })));
});

test('缺测原因允许新中文原因但必须有限非空，有效读数原因只能为null', () => {
  const missing = derived({ cpu_share_percent: null, cpu_core_percent: null, cpu_reason: '新设备原因', fps: null, fps_reason: '帧窗口不可用',
    battery_net_power_mw: null, battery_reason: '电池侧观测不可用' });
  assert.ok(consume(missing, metrics({ frame_window: null, device_observation: null })));
  for (const name of ['cpu_reason', 'fps_reason', 'battery_reason']) {
    for (const reason of [null, '', ' \t\n', '\u0000', '中'.repeat(1366)]) rejected({ ...missing, [name]: reason });
  }
  assert.ok(consume({ ...missing, battery_reason: 'a'.repeat(4096) }));
});

test('FPS有值必须匹配原有效窗口，零帧与缺测分别保留', () => {
  for (const value of [derived({ fps: NaN }), derived({ fps: Infinity }), derived({ fps: -1 }), derived({ fps: 1001 }),
    derived({ fps: 59 }), derived({ fps_reason: '没有窗口' })]) rejected(value);
  rejected(derived(), metrics({ frame_window: null }));
  rejected(derived(), metrics({ frame_window: { frames: 60, duration_ms: 1000, source: '' } }));
  const current = metrics({ frame_window: { frames: 0, duration_ms: 1000, source: 'android.gfxinfo.framestats' } });
  assert.equal(consume(derived({ fps: 0 }), current).samples[1]?.derived?.fps, 0);
  const missing = derived({ fps: null, fps_reason: '窗口缺测' });
  assert.equal(consume(missing, metrics({ frame_window: null })).samples[1]?.derived?.fps, null);
});

test('净电池功率按已知极性与原微单位核对，充电为正放电为负', () => {
  const current = metrics(); const battery = current.device_observation?.battery; assert.ok(battery);
  const withBattery = (overrides: Partial<typeof battery>): ProfileMetrics => metrics({ device_observation: {
    api_version: 1, scope: 'device', device_id: device, temperatures: [], battery: { ...battery, ...overrides } } });
  assert.ok(consume(derived(), withBattery({ current_ua: 2000000, current_polarity: 'positive_discharging' })));
  assert.ok(consume(derived({ battery_net_power_mw: 8000 }), withBattery({ current_ua: 2000000, status: 'charging', supply_state: 'external' })));
  assert.ok(consume(derived({ battery_net_power_mw: 0 }), withBattery({ current_ua: 0 })));
  for (const value of [derived({ battery_net_power_mw: 8000 }), derived({ battery_net_power_mw: -7999 }),
    derived({ battery_net_power_mw: NaN }), derived({ battery_net_power_mw: Infinity }), derived({ battery_net_power_mw: -5000001 }),
    derived({ battery_reason: '电流未知' })]) rejected(value);
  rejected(derived(), withBattery({ current_polarity: 'unknown' }));
  rejected(derived(), withBattery({ current_ua: null, current_polarity: 'unknown' }));
  rejected(derived(), metrics({ device_observation: null }));
  const missing = derived({ battery_net_power_mw: null, battery_reason: '电流极性未知' });
  assert.equal(consume(missing, withBattery({ current_polarity: 'unknown' })).samples[1]?.derived?.battery_net_power_mw, null);
});

test('数值核对容忍浮点舍入而不放宽字段范围，原指标仍拒绝混入派生字段', () => {
  assert.ok(consume(derived({ cpu_core_percent: 40 + 1e-9, fps: 60 + 1e-9, battery_net_power_mw: -8000 + 1e-6 })));
  rejected(derived({ cpu_core_percent: 40 + 1e-5 }));
  rejected(derived({ fps: 60 + 1e-5 }));
  rejected(derived({ battery_net_power_mw: -8000 + 1e-3 }));
  const raw = metrics();
  assert.throws(() => read([{ ...sample(0, raw), metrics: { ...raw, cpu_share_percent: 5 } }]), protocolLog);
});

test('battery_dumpsys缺电流的充电观测保留电压与电池温度，派生功率保持缺测', () => {
  // 代表公开降级合同；三星原件重放由独立测试驱动验收，不代表真实浏览器通过。
  const current = metrics({ device_observation: { api_version: 1, scope: 'device', device_id: device,
    battery: { observed_at: 2000, source: 'battery_dumpsys', access: 'adb_shell', voltage_uv: 3887000,
      current_ua: null, current_polarity: 'unknown', status: 'charging', supply_state: 'external' },
    temperatures: [{ observed_at: 2000, source: 'battery_dumpsys', access: 'adb_shell', sensor_kind: 'battery',
      sensor_name: 'battery', sensor_type: null, temperature_celsius: 34.1, status: null }] } });
  const reason = '电池电流不可用，无法计算净电池功率';
  const accepted = consume(derived({ battery_net_power_mw: null, battery_reason: reason }), current).samples[1];
  assert.equal(accepted?.derived?.battery_net_power_mw, null);
  assert.equal(accepted?.derived?.battery_reason, reason);
  assert.deepEqual(accepted?.metrics.device_observation, current.device_observation);
  assert.equal(accepted?.metrics.device_observation?.temperatures[0]?.temperature_celsius, 34.1);
});
