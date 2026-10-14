import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';

export const deviceId = 'observation-0001';
export const packageName = 'org.smoke.observation.game';
export const temperatureGolden = [
  {
    sensor_kind: 'cpu',
    sensor_name: 'cpu0',
    sensor_type: 0,
    temperature_celsius: 45.125,
    status: 2,
  },
  {
    sensor_kind: 'gpu',
    sensor_name: 'gpu0',
    sensor_type: 1,
    temperature_celsius: 43.75,
    status: 1,
  },
  {
    sensor_kind: 'skin',
    sensor_name: 'skin0',
    sensor_type: 3,
    temperature_celsius: 36.125,
    status: 0,
  },
];
const normal = {
  uevent:
    'POWER_SUPPLY_NAME=battery\nPOWER_SUPPLY_TYPE=Battery\nPOWER_SUPPLY_STATUS=Discharging\nPOWER_SUPPLY_VOLTAGE_NOW=4000000\nPOWER_SUPPLY_CURRENT_NOW=-500000\n',
  battery:
    'Current Battery Service state:\n  AC powered: false\n  USB powered: true\n  Wireless powered: false\n  Dock powered: false\n  Max charging current: 999999\n  status: 3\n  present: true\n  level: 70\n  voltage: 4200\n  temperature: 317\n',
  thermal:
    'Thermal Status: 2\nCached temperatures:\n  Temperature{mValue=99.0, mType=0, mName=cached-only, mStatus=6}\nHAL Ready: true\nCurrent temperatures from HAL:\n' +
    '  Temperature{mValue=45.125, mType=0, mName=cpu0, mStatus=2}\n' +
    '  Temperature{mValue=43.75, mType=1, mName=gpu0, mStatus=1}\n' +
    '  Temperature{mValue=36.125, mType=3, mName=skin0, mStatus=0}\n' +
    '  Temperature{mValue=NaN, mType=1, mName=unavailable-gpu, mStatus=0}\n' +
    '  Temperature{mValue=1000.0, mType=7, mName=bcl-current, mStatus=0}\n' +
    'Current cooling devices from HAL:\nTemperature static thresholds from HAL:\n',
};
const legacy = {
  uevent: '',
  battery:
    'Current Battery Service state:\n  (UPDATES STOPPED -- use reset to restart)\n  voltage: 4200\n  temperature: 317\n',
  thermal: 'HAL Ready: false\n',
};

export async function prepareFixture(directory, binary) {
  const root = join(directory, 'fixture');
  await mkdir(root);
  const adb = join(root, 'fake-adb.exe');
  await copyFile(binary, adb);
  assert.equal((await fileIdentity(binary)).sha256, (await fileIdentity(adb)).sha256);
  for (const [mode, values] of Object.entries({ normal, legacy })) {
    const destination = join(root, 'inputs', mode);
    await mkdir(destination, { recursive: true });
    for (const [name, text] of Object.entries(values))
      await writeFile(join(destination, name + '.txt'), text, { flag: 'wx' });
  }
  await writeFile(join(root, 'mode'), 'normal', { flag: 'wx' });
  return { root, adb };
}
export async function setMode(fixture, mode) {
  assert.ok(['normal', 'legacy'].includes(mode));
  const pending = join(fixture.root, 'mode.tmp');
  await writeFile(pending, mode);
  await rename(pending, join(fixture.root, 'mode'));
}
export function assertObservation(observation, capturedAt) {
  assert.equal(observation.api_version, 1);
  assert.equal(observation.scope, 'device');
  assert.equal(observation.device_id, deviceId);
  const battery = observation.battery;
  assert.ok(battery);
  assert.equal(battery.voltage_uv, 4000000);
  assert.equal(battery.current_ua, -500000);
  assert.equal(battery.current_polarity, 'positive_charging');
  assert.equal(battery.status, 'discharging');
  assert.equal(battery.supply_state, 'external');
  assert.equal(battery.access, 'adb_shell');
  assert.match(battery.source, /^[a-zA-Z0-9_.:-]{1,80}$/);
  const temperatureKeys = [
    'sensor_kind',
    'sensor_name',
    'sensor_type',
    'temperature_celsius',
    'status',
  ];
  for (const expected of temperatureGolden) {
    const found = observation.temperatures.find(
      (value) => value.sensor_name === expected.sensor_name,
    );
    assert.ok(found);
    assert.deepEqual(Object.fromEntries(temperatureKeys.map((key) => [key, found[key]])), expected);
    assert.equal(found.access, 'adb_shell');
    assert.match(found.source, /^[a-zA-Z0-9_.:-]{1,80}$/);
  }
  assert.ok(
    observation.temperatures.some(
      (value) =>
        value.sensor_kind === 'battery' &&
        value.temperature_celsius === 31.7 &&
        value.sensor_type == null,
    ),
  );
  assert.ok(
    !observation.temperatures.some((value) =>
      ['cached-only', 'unavailable-gpu', 'bcl-current'].includes(value.sensor_name),
    ),
  );
  for (const member of [battery, ...observation.temperatures]) {
    assert.ok(
      Number.isSafeInteger(member.observed_at) &&
        member.observed_at <= capturedAt &&
        member.observed_at >= capturedAt - 10000,
    );
  }
}
export function assertReading(reading, legacy = false) {
  if (legacy) {
    assert.ok(reading.device_observation == null);
    assert.ok(reading.battery_net_power_mw == null);
    return;
  }
  assertObservation(reading.device_observation, reading.captured_at);
  assert.equal(
    reading.battery_net_power_mw,
    -2000,
    '净电池功率保留负放电，不能取绝对值或冒充负载功耗',
  );
}
