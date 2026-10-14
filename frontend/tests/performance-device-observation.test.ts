import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isDeviceObservation,
  isReadingDeviceObservation,
} from '../src/features/performance/utils/device-observation.ts';
import {
  decodePerformanceCapabilities,
  isPerformancePage,
} from '../src/features/performance/utils/results.ts';
import { HostError } from '../src/plugin-sdk/index.ts';
import { deviceObservation, observationReading } from './performance-observation-fixtures.ts';

const deviceId = 'emulator-5554';
const capturedAt = 1001;
const valid = (observation: unknown, netPower: unknown = undefined) =>
  isReadingDeviceObservation(observation, netPower, deviceId, capturedAt);

function battery() {
  const value = deviceObservation().battery;
  assert.ok(value);
  return value;
}
function temperature() {
  const value = deviceObservation().temperatures[0];
  assert.ok(value);
  return value;
}

test('设备观测兼容历史缺省与null，保留原单位、负电流与净电池功率', () => {
  assert.ok(valid(undefined));
  assert.ok(valid(null, null));
  const observation = deviceObservation();
  const original = JSON.stringify(observation);
  assert.ok(valid(observation, -8000));
  assert.equal(JSON.stringify(observation), original);
  assert.equal(observation.battery?.current_ua, -2000000);
  assert.equal(observation.battery?.voltage_uv, 4000000);
  assert.ok(valid({ ...observation, battery: null }));
  assert.ok(valid({ ...observation, temperatures: [] }, -8000));
  assert.ok(
    valid({
      ...observation,
      battery: { ...battery(), current_ua: null, current_polarity: 'unknown' },
    }),
  );
});

test('观测拒绝版本、设备归属、空容器、错误单位及过期或未来时间', () => {
  const observation = deviceObservation();
  const invalid: unknown[] = [
    { ...observation, api_version: 2 },
    { ...observation, scope: 'main_process' },
    { ...observation, device_id: 'other-device' },
    { ...observation, battery: null, temperatures: [] },
    {
      ...observation,
      battery: null,
      temperatures: Array.from({ length: 33 }, (_, index) => ({
        ...temperature(),
        sensor_name: 'sensor-' + index,
      })),
    },
    { ...observation, battery: { ...battery(), observed_at: 1002 } },
    { ...observation, battery: { ...battery(), voltage_uv: 0 } },
    { ...observation, battery: { ...battery(), voltage_uv: 50000001 } },
    { ...observation, battery: { ...battery(), current_ua: -100000001 } },
    { ...observation, battery: { ...battery(), current_ua: 1.5 } },
    { ...observation, battery: { ...battery(), source: '来源' } },
    { ...observation, battery: { ...battery(), source: 'x'.repeat(81) } },
    { ...observation, battery: { ...battery(), access: 'unknown' } },
    { ...observation, available: true },
  ];
  for (const value of invalid) assert.equal(valid(value), false);
  assert.equal(
    isDeviceObservation(
      { ...observation, battery: { ...battery(), observed_at: 1000 }, temperatures: [] },
      deviceId,
      11001,
    ),
    false,
  );
  assert.ok(
    isDeviceObservation(
      { ...observation, battery: { ...battery(), observed_at: 1000 }, temperatures: [] },
      deviceId,
      11000,
    ),
  );
});

test('已知极性按冻结状态核对，零与未知极性保持原值，功率必须有合格电流', () => {
  const observation = deviceObservation();
  const withBattery = (patch: Record<string, unknown>) => ({
    ...observation,
    battery: { ...battery(), ...patch },
  });
  assert.ok(
    valid(withBattery({ current_ua: 2000000, current_polarity: 'positive_discharging' }), -8000),
  );
  assert.ok(valid(withBattery({ current_ua: 0, status: 'charging' }), 0));
  assert.ok(
    valid(withBattery({ current_ua: 2000000, status: 'charging', supply_state: 'external' }), 8000),
  );
  assert.ok(valid(withBattery({ current_polarity: 'unknown', status: 'charging' })));
  assert.ok(valid(withBattery({ status: 'full' }), -8000));
  for (const value of [
    withBattery({ current_ua: null }),
    withBattery({ current_ua: undefined }),
    withBattery({ status: 'charging' }),
    withBattery({ current_ua: 2000000 }),
    withBattery({ current_ua: 2000000, status: 'charging', supply_state: 'battery' }),
    withBattery({ current_polarity: 'positive_discharging' }),
    withBattery({ current_polarity: 'invalid' }),
  ])
    assert.equal(valid(value), false);
  for (const [value, power] of [
    [undefined, 0],
    [null, -1],
    [{ ...observation, battery: null }, 1],
    [withBattery({ current_ua: null, current_polarity: 'unknown' }), 1],
    [withBattery({ current_polarity: 'unknown' }), -8000],
    [observation, NaN],
    [observation, Infinity],
    [observation, 5000001],
    [observation, -5000001],
  ])
    assert.equal(valid(value, power), false);
  const maximum = withBattery({ voltage_uv: 50000000, current_ua: -100000000 });
  assert.ok(valid(maximum, -5000000));
});

test('温度保留传感器来源与负值，拒绝BCL、类型混用、非有限值与重复身份', () => {
  const observation = deviceObservation();
  const withTemperature = (patch: Record<string, unknown>) => ({
    ...observation,
    temperatures: [{ ...temperature(), ...patch }],
  });
  assert.ok(valid(withTemperature({ temperature_celsius: -40 })));
  assert.ok(
    valid(withTemperature({ sensor_type: 0, sensor_kind: 'cpu', temperature_celsius: -273.15 })),
  );
  assert.ok(
    valid(withTemperature({ sensor_type: 1, sensor_kind: 'gpu', temperature_celsius: 400 })),
  );
  assert.ok(valid(withTemperature({ sensor_type: 3, sensor_kind: 'skin', status: 6 })));
  assert.ok(valid(withTemperature({ sensor_type: 64, sensor_kind: 'other' })));
  assert.ok(valid(withTemperature({ sensor_type: null, status: null })));
  assert.ok(valid(withTemperature({ sensor_name: '温'.repeat(42) })));
  for (const patch of [
    { sensor_type: 6, sensor_kind: 'other' },
    { sensor_type: 7, sensor_kind: 'other' },
    { sensor_type: 8, sensor_kind: 'other' },
    { sensor_type: 65 },
    { sensor_type: 0, sensor_kind: 'gpu' },
    { sensor_type: 4, sensor_kind: 'cpu' },
    { status: -1 },
    { status: 7 },
    { sensor_name: '' },
    { sensor_name: '温'.repeat(43) },
    { sensor_name: 'battery\n' },
    { temperature_celsius: NaN },
    { temperature_celsius: Infinity },
    { temperature_celsius: -273.16 },
    { temperature_celsius: 400.1 },
    { observed_at: 1002 },
    { source: 'cached temperatures' },
  ])
    assert.equal(valid(withTemperature(patch)), false);
  assert.equal(valid({ ...observation, temperatures: [temperature(), temperature()] }), false);
  assert.ok(
    valid({
      ...observation,
      temperatures: [temperature(), { ...temperature(), sensor_name: 'other-battery' }],
    }),
  );
});

test('传感器名称拒绝UTF8解码替换字符，保留合法中文名称原文', () => {
  const observation = deviceObservation();
  for (const sensorName of ['\ufffd', '电池\ufffd温度', '\ufffdbattery', 'battery\ufffd']) {
    assert.equal(
      valid({ ...observation, temperatures: [{ ...temperature(), sensor_name: sensorName }] }),
      false,
    );
  }
  const sensorName = '电池温度';
  const current = { ...observation, temperatures: [{ ...temperature(), sensor_name: sensorName }] };
  assert.ok(valid(current));
  assert.equal(current.temperatures[0]?.sensor_name, sensorName);
});

test('样本页连接设备观测规则，历史不反填，领域派生值原样保留', () => {
  const session = {
    id: '11111111-1111-4111-8111-111111111111',
    request: {
      target: { device_id: deviceId, package: 'com.example.app' },
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
  const reading = observationReading();
  const page = { session, readings: [reading], next_after: 1 };
  assert.ok(isPerformancePage(page));
  assert.equal(page.readings[0]?.battery_net_power_mw, -8000);
  assert.equal(
    isPerformancePage({
      ...page,
      readings: [
        { ...reading, device_observation: { ...deviceObservation(), device_id: 'other' } },
      ],
    }),
    false,
  );
  assert.equal(
    isPerformancePage({ ...page, readings: [{ ...reading, device_observation: null }] }),
    false,
  );
  const { device_observation, battery_net_power_mw, ...legacy } = reading;
  assert.ok(device_observation);
  assert.equal(battery_net_power_mw, -8000);
  assert.ok(isPerformancePage({ ...page, readings: [legacy] }));
  assert.equal('device_observation' in legacy, false);
  const nullable = { ...legacy, device_observation: null, battery_net_power_mw: null };
  assert.ok(isPerformancePage({ ...page, readings: [nullable] }));
  assert.equal(nullable.device_observation, null);
});

test('能力声明兼容旧缺省与false，声明true时要求两项设备指标', () => {
  const legacy = {
    metrics: ['cpu_share_percent', 'cpu_core_percent', 'pss_kib', 'rss_kib', 'fps'],
    fps: true,
    source: 'plugin.android-device',
    scope: 'main_process',
    max_samples: 3600,
    sample_timeout_ms: 10000,
  };
  assert.equal(decodePerformanceCapabilities(legacy, null).deviceObservation, false);
  assert.equal(
    decodePerformanceCapabilities({ ...legacy, device_observation: false }, null).deviceObservation,
    false,
  );
  const declared = {
    ...legacy,
    device_observation: true,
    metrics: [...legacy.metrics, 'device_observation', 'battery_net_power_mw'],
  };
  const decoded = decodePerformanceCapabilities(declared, 'cap-log');
  assert.equal(decoded.deviceObservation, true);
  assert.equal(decoded.scope, 'main_process');
  assert.deepEqual(decoded.metrics, declared.metrics);
  for (const value of [
    { ...legacy, device_observation: true },
    { ...declared, device_observation: false },
    { ...declared, device_observation: null },
    { ...declared, scope: 'device' },
    { ...declared, metrics: [...legacy.metrics, 'device_observation', 'device_observation'] },
  ]) {
    assert.throws(
      () => decodePerformanceCapabilities(value, 'cap-log'),
      (error: unknown) =>
        error instanceof HostError &&
        error.code === 'invalid_performance_result' &&
        error.logId === 'cap-log',
    );
  }
});

test('观测设备标识按UTF8原文资格检查，精确匹配且不截断或规范化', () => {
  const original = ' 中 文@% ';
  const observation = { ...deviceObservation(), device_id: original };
  assert.ok(isDeviceObservation(observation, original, capturedAt));
  assert.equal(observation.device_id, original);
  assert.equal(isDeviceObservation(observation, original.trim(), capturedAt), false);
  const boundary = '中'.repeat(66);
  assert.ok(isDeviceObservation({ ...observation, device_id: boundary }, boundary, capturedAt));
  for (const id of ['中'.repeat(67), '   ', '-设备', 'device\n'])
    assert.equal(isDeviceObservation({ ...observation, device_id: id }, id, capturedAt), false);
});

test('样本页接受battery_dumpsys缺电流充电观测，保留34.1度电池温度且不反填功率', () => {
  // 代表公开降级合同；温度来自电池服务，不将此用例计为原件或真实浏览器验收。
  const observation = {
    ...deviceObservation(),
    battery: {
      ...battery(),
      source: 'battery_dumpsys',
      voltage_uv: 3887000,
      current_ua: null,
      current_polarity: 'unknown',
      status: 'charging',
      supply_state: 'external',
    },
    temperatures: [
      {
        ...temperature(),
        source: 'battery_dumpsys',
        sensor_name: 'battery',
        sensor_type: null,
        temperature_celsius: 34.1,
        status: null,
      },
    ],
  };
  const session = {
    id: '11111111-1111-4111-8111-111111111111',
    request: {
      target: { device_id: deviceId, package: 'com.example.app' },
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
  const page = {
    session,
    readings: [
      { ...observationReading(), device_observation: observation, battery_net_power_mw: null },
    ],
    next_after: 1,
  };
  assert.ok(isPerformancePage(page));
  assert.equal(page.readings[0]?.battery_net_power_mw, null);
  assert.deepEqual(page.readings[0]?.device_observation, observation);
  assert.equal(page.readings[0]?.device_observation?.temperatures[0]?.temperature_celsius, 34.1);
});
