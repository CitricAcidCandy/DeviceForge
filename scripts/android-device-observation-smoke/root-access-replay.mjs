import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareHost, reservePort } from '../android-packages-smoke/host.mjs';
import { failure, fileIdentity, inputManifest, retain, writeJsonBatches } from './evidence.mjs';
import { deviceId } from '../android-profile-smoke/probe-route.mjs';
import { recordContract } from '../android-profile-smoke/record-route.mjs';
import { recordBusiness } from '../android-profile-smoke/record-cases.mjs';
import {
  canonicalArgv,
  prepareFixture,
  verifyFixture,
} from '../android-profile-smoke/fixtures.mjs';
import {
  actualFrontend,
  freezeFrontend,
  verifyFrontend,
} from '../android-profile-smoke/frontend.mjs';
import { finishPendingProbes, observeTools } from '../android-profile-smoke/processes.mjs';
import { temperatureGolden } from './fixtures.mjs';

// 两次无媒体短录制只核真实会话通道来源；不运行真机、性能压测或既有生命周期矩阵。
const args = process.argv.slice(2),
  names = ['--frozen-input', '--plugin-input', '--tool', '--probe'];
if (args.length === 1 && args[0] === '--help') {
  console.log(
    'node scripts/android-device-observation-smoke/root-access-replay.mjs --frozen-input=宿主冻结目录 --plugin-input=插件冻结目录 --tool=已有profile原生假ADB --probe=OS探针',
  );
  process.exit(0);
}
assert.ok(
  args.every((value) => names.some((name) => value.startsWith(name + '='))),
  'ROOT-ACCESS-ARGUMENT',
);
const option = (name) => {
  const values = args.filter((value) => value.startsWith(name + '='));
  assert.equal(values.length, 1, 'ROOT-ACCESS-EXPLICIT-INPUT');
  assert.ok(values[0].slice(name.length + 1));
  return resolve(values[0].slice(name.length + 1));
};
const root = fileURLToPath(new URL('../../', import.meta.url)),
  frozen = option(names[0]),
  pluginFrozen = option(names[1]);
const directory = join(root, 'artifacts', 'android-root-access-debug-' + randomUUID()),
  snapshot = join(directory, 'snapshot');
await mkdir(snapshot, { recursive: true });
const report = {
  timestamp: new Date().toISOString(),
  profile: 'debug',
  passed: false,
  checks: [],
  requests: [],
  jobs: [],
  tools: [],
  history: [],
  scope: 'UID0及普通无Root真实Session、环境观测来源、HTTP/MCP同Job、ZIP及实际前端归档消费',
  limitations: [
    '原生固定输出不证明Root真机、OEM或传感器精度',
    '原OS句柄仅证明直接工具和父插件，不证明远端进程或派生树',
    '本批无媒体、浏览器、Release、正式分发或性能验收',
  ],
};
process.once('exit', (code) =>
  writeFileSync(
    join(directory, 'driver-process-exit.json'),
    JSON.stringify({
      timestamp: new Date().toISOString(),
      pid: process.pid,
      code,
      source: '本驱动实际process exit事件，父级原child句柄退出由主代理另记',
    }) + '\n',
    'utf8',
  ),
);
const environmental = {
  uevent:
    'POWER_SUPPLY_NAME=battery\nPOWER_SUPPLY_TYPE=Battery\nPOWER_SUPPLY_STATUS=Discharging\nPOWER_SUPPLY_VOLTAGE_NOW=4000000\nPOWER_SUPPLY_CURRENT_NOW=-500000\n',
  battery:
    'Current Battery Service state:\n  AC powered: false\n  USB powered: true\n  Wireless powered: false\n  Dock powered: false\n  status: 3\n  present: true\n  voltage: 4200\n  temperature: 317\n',
  thermal:
    'HAL Ready: true\nCurrent temperatures from HAL:\n' +
    temperatureGolden
      .map(
        (value) =>
          '  Temperature{mValue=' +
          value.temperature_celsius +
          ', mType=' +
          value.sensor_type +
          ', mName=' +
          value.sensor_name +
          ', mStatus=' +
          value.status +
          '}\n',
      )
      .join('') +
    'Current cooling devices from HAL:\n',
};
const contract = {
  ...recordContract,
  config: { ...recordContract.config, root_access: 'adbd_root' },
  route: '双Session环境权限来源资格',
  cases: ['record-no-simpleperf', 'record-no-root'].map((id, index) => {
    const base = recordContract.cases.find((value) => value.id === id);
    assert.ok(base);
    return {
      ...base,
      id: index ? 'adb-access' : 'root-access',
      expected: { ...base.expected },
      expected_access: index ? 'adb_shell' : 'root_shell',
      commands: base.commands
        .filter((spec) => spec.category !== 'su-id')
        .map((spec) => ({
          ...spec,
          argv: [...spec.argv],
          outputs:
            spec.category in environmental
              ? [
                  {
                    stdout: Buffer.from(environmental[spec.category]),
                    stderr: Buffer.alloc(0),
                    exit: 0,
                  },
                ]
              : spec.outputs.map((output) => ({
                  ...output,
                  stdout: Buffer.from(output.stdout),
                  stderr: Buffer.from(output.stderr),
                })),
        })),
    };
  }),
};
function assertEnvironment(profile, scenario) {
  assert.equal(profile.result.root_access, scenario.expected.root_access);
  assert.equal(profile.result.stack_status, 'unavailable');
  assert.equal(profile.result.sample_count, 1);
  assert.equal(profile.result.frame_status, 'disabled');
  const sample = profile.index.samples[0],
    observation = sample.metrics.device_observation;
  assert.ok(observation);
  assert.equal(observation.api_version, 1);
  assert.equal(observation.scope, 'device');
  assert.equal(observation.device_id, deviceId);
  const battery = observation.battery;
  assert.ok(battery);
  const access = scenario.expected_access;
  assert.deepEqual(
    Object.fromEntries(
      [
        'source',
        'access',
        'voltage_uv',
        'current_ua',
        'current_polarity',
        'status',
        'supply_state',
      ].map((key) => [key, battery[key]]),
    ),
    {
      source: 'battery_sysfs_uevent',
      access,
      voltage_uv: 4000000,
      current_ua: -500000,
      current_polarity: 'positive_charging',
      status: 'discharging',
      supply_state: 'external',
    },
  );
  const expectedTemperatures = [
    ...temperatureGolden.map((value) => ({ ...value, source: 'thermal_hal_current', access })),
    {
      sensor_kind: 'battery',
      sensor_name: 'battery',
      sensor_type: null,
      temperature_celsius: 31.7,
      status: null,
      source: 'battery_dumpsys',
      access,
    },
  ];
  assert.equal(observation.temperatures.length, expectedTemperatures.length);
  for (const expected of expectedTemperatures) {
    const found = observation.temperatures.find(
      (value) => value.sensor_name === expected.sensor_name,
    );
    assert.ok(found);
    assert.deepEqual(
      Object.fromEntries(Object.keys(expected).map((key) => [key, found[key] ?? null])),
      expected,
    );
  }
  for (const value of [battery, ...observation.temperatures])
    assert.ok(
      Number.isSafeInteger(value.observed_at) &&
        value.observed_at <= sample.metrics.captured_at &&
        value.observed_at >= sample.metrics.captured_at - 10000,
    );
  assert.equal(sample.derived.battery_net_power_mw, -2000, 'ROOT-ACCESS-SIGNED-NET-BATTERY-POWER');
}
async function planIdentities(fixture) {
  const entries = [];
  async function visit(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await visit(path);
      else {
        assert.ok(entry.isFile());
        entries.push(await fileIdentity(path));
        assert.ok(entries.length <= 4096);
      }
    }
  }
  await visit(join(fixture.root, 'inputs'));
  return entries;
}
let host,
  observer,
  fixture,
  inputPaths,
  fixtureInputs,
  stage = '冻结输入';
const binaryNames = [
  'apk-server.exe',
  'deviceforge-android-device-plugin.exe',
  'manifest.json',
  'fake-adb.exe',
  'process-probe.exe',
];
const sources = [
  join(frozen, binaryNames[0]),
  join(pluginFrozen, binaryNames[1]),
  join(pluginFrozen, binaryNames[2]),
  option(names[2]),
  option(names[3]),
];
try {
  assert.equal(process.platform, 'win32', 'ROOT-ACCESS-WINDOWS-OS-HANDLE');
  const frontendRoot = await freezeFrontend(root, join(snapshot, 'frontend'), report);
  inputPaths = [
    ...sources,
    join(root, 'scripts/android-profile-smoke/fake-adb.rs'),
    ...(report.frontend_snapshots ?? []).map((item) => item.source.path),
  ];
  report.inputs_before = await inputManifest(fileURLToPath(import.meta.url), inputPaths);
  report.snapshots = [];
  for (const [index, path] of sources.entries()) {
    const source = await fileIdentity(path),
      target = join(snapshot, binaryNames[index]);
    await copyFile(path, target);
    const actual = await fileIdentity(target);
    assert.equal(actual.sha256, source.sha256);
    assert.equal(actual.bytes, source.bytes);
    report.snapshots.push({ source, actual });
  }
  fixture = await prepareFixture(directory, join(snapshot, 'fake-adb.exe'), contract, report);
  fixtureInputs = await planIdentities(fixture);
  report.fixture_inputs = fixtureInputs;
  const config = join(snapshot, 'android-device.config.json');
  await writeFile(
    config,
    JSON.stringify({ format_version: 1, tools: { adb: fixture.adb }, profile: contract.config }),
    { flag: 'wx' },
  );
  report.config = await fileIdentity(config);
  const manifest = JSON.parse(await readFile(join(snapshot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.id, 'android-device');
  assert.equal(manifest.protocol_version, 4);
  assert.ok(manifest.operations.some((value) => value.name === 'profile.record'));
  manifest.executable = join(snapshot, 'deviceforge-android-device-plugin.exe');
  host = await prepareHost({
    root,
    binary: join(snapshot, 'apk-server.exe'),
    directory: join(directory, 'data'),
    report,
    port: await reservePort(),
  });
  await host.ready();
  host.assertRunning();
  const deployment = join(host.plugins, 'android-device');
  await mkdir(deployment);
  const deployedManifest = join(deployment, 'manifest.json');
  await writeFile(deployedManifest, JSON.stringify(manifest), { flag: 'wx' });
  report.deployed_manifest = await fileIdentity(deployedManifest);
  observer = observeTools(
    fixture,
    join(snapshot, 'process-probe.exe'),
    manifest.executable,
    report,
  );
  const loaded = await host.client.post('/api/v2/plugins/android-device/load');
  assert.equal(loaded.state, 'loaded');
  stage = '双Session真实Job、ZIP及实际前端消费';
  await recordBusiness(
    host,
    fixture,
    observer,
    loaded,
    report,
    directory,
    await actualFrontend(frontendRoot),
  );
  assert.equal(report.profiles.length, 2);
  assert.equal(report.jobs.length, 2);
  assert.equal(report.history.length, 2);
  for (const scenario of fixture.cases) {
    const profiles = report.profiles.filter((value) => value.case_id === scenario.id);
    assert.equal(profiles.length, 1);
    assertEnvironment(profiles[0], scenario);
    const tools = report.tools.filter((value) => value.mode === scenario.id);
    assert.ok(
      !tools.some((value) => value.category === 'su-id' || value.argv.includes('su')),
      'ROOT-ACCESS-NO-SU-INVOCATION',
    );
    const rootIds = tools.filter((value) => value.category === 'root-id');
    assert.equal(rootIds.length, 1);
    assert.deepEqual(
      await readFile(join(rootIds[0].directory, 'stdout.bin')),
      Buffer.from(scenario.expected_access === 'root_shell' ? '0\n' : '2000\n'),
    );
    const simpleperf = tools.filter((value) => value.category === 'simpleperf-version');
    assert.equal(simpleperf.length, scenario.expected_access === 'root_shell' ? 1 : 0);
    for (const tool of simpleperf) assert.equal(tool.planned_exit, 1);
    for (const category of ['uevent', 'battery', 'thermal']) {
      const selected = tools.filter((value) => value.category === category);
      assert.equal(selected.length, 1);
      const argv = selected[0].argv;
      assert.deepEqual(argv.slice(0, 4), ['-s', deviceId, 'shell', '-T']);
      if (scenario.expected_access === 'root_shell') {
        assert.equal(argv.length, 7);
        assert.deepEqual(argv.slice(4, 6), ['/system/bin/sh', '-c']);
      } else assert.equal(argv[4], category === 'uevent' ? 'cat' : 'dumpsys');
    }
  }
  report.checks.push({
    name: 'UID0无Simpleperf环境仍为RootShell、普通无Root为AdbShell且无su，来源/单位/负净功率一致',
    passed: true,
  });
  observer.assertHealthy();
  host.assertRunning();
  stage = '正常退出与原OS句柄';
  await host.shutdown();
  await observer.finish();
  observer = undefined;
  await host.verifyIdentity();
  await verifyFrontend(report);
  for (const tool of report.tools) {
    const scenario = fixture.cases.find((value) => value.id === tool.mode),
      argv = canonicalArgv(tool.argv, fixture, tool.mode);
    const specs = [...fixture.shared, ...scenario.commands].filter(
      (value) => JSON.stringify(value.argv) === JSON.stringify(argv),
    );
    assert.equal(specs.length, 1);
    const output = specs[0].outputs[Math.min(tool.ordinal, specs[0].outputs.length - 1)];
    assert.deepEqual(
      await readFile(join(tool.directory, 'stdout.bin')),
      Buffer.from(output.stdout),
    );
    assert.deepEqual(
      await readFile(join(tool.directory, 'stderr.bin')),
      Buffer.from(output.stderr),
    );
    const ready = JSON.parse(await readFile(join(tool.directory, 'process.ready.json'), 'utf8')),
      exited = JSON.parse(await readFile(join(tool.directory, 'process.exit.json'), 'utf8'));
    assert.deepEqual(ready, tool.probe_ready);
    assert.deepEqual(exited, tool.process.exit);
    assert.equal(tool.process.probe_exit.code, 0);
    for (const role of ['target', 'parent'])
      assert.equal(ready[role].creation_time_100ns, exited[role].creation_time_100ns);
  }
  stage = '输入与产物身份';
  await verifyFixture(fixture, report);
  report.inputs_after = await inputManifest(fileURLToPath(import.meta.url), inputPaths);
  assert.deepEqual(report.inputs_after, report.inputs_before);
  for (const entry of report.snapshots)
    assert.deepEqual(await fileIdentity(entry.actual.path), entry.actual);
  for (const entry of fixtureInputs) assert.deepEqual(await fileIdentity(entry.path), entry);
  assert.deepEqual(await fileIdentity(config), report.config);
  assert.deepEqual(await fileIdentity(deployedManifest), report.deployed_manifest);
  report.checks.push({
    name: '每份工具输出及原OS创建时间/退出原件一致、宿主exit0/端口释放、全部冻结输入稳定',
    passed: true,
  });
  report.passed = true;
} catch (error) {
  failure(report, error, stage);
} finally {
  if (host)
    try {
      await host.finish();
    } catch (error) {
      failure(report, error, '收口自有宿主');
    }
  if (observer)
    try {
      await observer.stop();
    } catch (error) {
      failure(report, error, '停止工具观察器');
    }
  try {
    await finishPendingProbes(report);
  } catch (error) {
    failure(report, error, '收口原句柄探针');
  }
  report.response_log_ids = [...(host?.client.logIds ?? [])].sort();
  report.completed_at = new Date().toISOString();
  try {
    await retain(directory, report);
  } catch (error) {
    failure(report, error, '有界保留原件');
  }
  await writeJsonBatches(join(directory, 'report.json'), report);
  console.log(
    JSON.stringify({
      directory,
      passed: report.passed,
      checks: report.checks.length,
      jobs: report.jobs.length,
      tools: report.tools.length,
    }),
  );
  process.exitCode = report.passed ? 0 : 1;
}
