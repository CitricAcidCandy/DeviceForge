import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareHost, reservePort } from '../android-packages-smoke/host.mjs';
import { poll } from '../device-provider/client.mjs';
import { operation } from './cases.mjs';
import { failure, fileIdentity, inputManifest, retain, writeJsonBatches } from './evidence.mjs';
import { actualFrontend, freezeFrontend, verifyFrontend } from './frontend.mjs';
import { prepareFixture, deviceId, packageName } from './fixtures.mjs';
import { finishPendingProbes, observeTools } from './processes.mjs';

// 仅重放显式原件与不可用 sysfs 分支，不运行真实 ADB，也不猜厂商电流单位。
const args = process.argv.slice(2),
  names = ['--frozen-input', '--plugin-input', '--tool', '--probe', '--battery-input'];
if (args.length === 1 && args[0] === '--help') {
  console.log(
    'node scripts/android-device-observation-smoke/oem-replay.mjs --frozen-input=宿主冻结目录 --plugin-input=插件冻结目录 --tool=原生假ADB --probe=OS探针 --battery-input=真实battery-service.json',
  );
  process.exit(0);
}
assert.ok(
  args.every((value) => names.some((name) => value.startsWith(name + '='))),
  'AD-OBS-OEM-ARGUMENT',
);
const option = (name) => {
  const values = args.filter((value) => value.startsWith(name + '='));
  assert.equal(values.length, 1, 'AD-OBS-OEM-EXPLICIT-INPUT');
  assert.ok(values[0].slice(name.length + 1));
  return resolve(values[0].slice(name.length + 1));
};
const root = fileURLToPath(new URL('../../', import.meta.url)),
  frozen = option(names[0]),
  pluginFrozen = option(names[1]);
const directory = join(root, 'artifacts', 'android-device-observation-oem-debug-' + randomUUID()),
  snapshot = join(directory, 'snapshot');
await mkdir(snapshot, { recursive: true });
const report = {
  timestamp: new Date().toISOString(),
  profile: 'debug',
  passed: false,
  checks: [],
  requests: [],
  jobs: [],
  sessions: [],
  tools: [],
  history: [],
  scope: '真实 BatteryService 原 stdout、不可用 sysfs、当前冻结宿主/插件与实际前端历史消费',
  limitations: [
    '空 uevent 仅代表不可用，未复现真实 Permission denied 的 stderr/exit1',
    '原件重放不替代真机采集、传感器精度、页面或性能验收',
  ],
};
process.once('exit', (code) =>
  writeFileSync(
    join(directory, 'driver-process-exit.json'),
    JSON.stringify({
      timestamp: new Date().toISOString(),
      pid: process.pid,
      code,
      source: '本驱动实际 process exit 事件，父级原 child 句柄退出由主代理另记',
    }) + '\n',
    'utf8',
  ),
);
let host,
  observer,
  frontend,
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
  ],
  batteryInput = option(names[4]);
function assertReading(reading) {
  const value = reading.device_observation;
  assert.ok(value, 'AD-OBS-OEM-OBSERVATION');
  assert.deepEqual([value.api_version, value.scope, value.device_id], [1, 'device', deviceId]);
  const battery = value.battery;
  assert.ok(battery);
  assert.deepEqual(
    [
      battery.source,
      battery.access,
      battery.voltage_uv,
      battery.status,
      battery.supply_state,
      battery.current_ua ?? null,
      battery.current_polarity,
    ],
    ['battery_dumpsys', 'adb_shell', 3887000, 'charging', 'external', null, 'unknown'],
  );
  assert.equal(reading.battery_net_power_mw ?? null, null, 'AD-OBS-OEM-NO-UNIT-NO-POWER');
  assert.equal(value.temperatures.length, 1);
  const temperature = value.temperatures[0];
  assert.deepEqual(
    [
      temperature.source,
      temperature.access,
      temperature.sensor_kind,
      temperature.sensor_name,
      temperature.sensor_type ?? null,
      temperature.status ?? null,
      temperature.temperature_celsius,
    ],
    ['battery_dumpsys', 'adb_shell', 'battery', 'battery', null, null, 34.1],
  );
  for (const member of [battery, temperature])
    assert.ok(
      Number.isSafeInteger(member.observed_at) &&
        member.observed_at <= reading.captured_at &&
        member.observed_at >= reading.captured_at - 10000,
    );
}
try {
  assert.equal(process.platform, 'win32', 'AD-OBS-OEM-WINDOWS');
  const original = JSON.parse(await readFile(batteryInput, 'utf8'));
  assert.equal(original.exit_code, 0);
  assert.equal(typeof original.stdout, 'string');
  assert.ok(
    original.stdout.includes('BatteryInfoBackUp') && original.stdout.includes('current now:'),
    'AD-OBS-OEM-RAW-INPUT',
  );
  report.battery_input = await fileIdentity(batteryInput);
  report.replay_stdout_utf8_bytes = Buffer.byteLength(original.stdout);
  report.original_args = original.args;
  const frontendRoot = await freezeFrontend(root, join(snapshot, 'frontend'), report);
  inputPaths = [
    ...sources,
    batteryInput,
    join(root, 'scripts/android-device-observation-smoke/fake-adb.rs'),
    ...report.frontend_snapshots.map((value) => value.source.path),
  ];
  report.inputs_before = await inputManifest(fileURLToPath(import.meta.url), inputPaths);
  report.snapshots = [];
  for (let index = 0; index < sources.length; index++) {
    const source = await fileIdentity(sources[index]),
      target = join(snapshot, binaryNames[index]);
    await copyFile(sources[index], target);
    const actual = await fileIdentity(target);
    assert.equal(actual.sha256, source.sha256);
    assert.equal(actual.bytes, source.bytes);
    report.snapshots.push({ source, actual });
  }
  fixture = await prepareFixture(directory, join(snapshot, 'fake-adb.exe'));
  for (const [name, text] of Object.entries({ uevent: '', battery: original.stdout, thermal: '' }))
    await writeFile(join(fixture.root, 'inputs', 'normal', name + '.txt'), text, 'utf8');
  const replay = join(fixture.root, 'inputs', 'normal', 'battery.txt');
  assert.equal(await readFile(replay, 'utf8'), original.stdout, 'AD-OBS-OEM-VERBATIM-STDOUT');
  fixtureInputs = await Promise.all(
    ['uevent', 'battery', 'thermal'].map((name) =>
      fileIdentity(join(fixture.root, 'inputs', 'normal', name + '.txt')),
    ),
  );
  report.fixture_inputs = fixtureInputs;
  const config = join(snapshot, 'android-device.config.json');
  await writeFile(config, JSON.stringify({ format_version: 1, tools: { adb: fixture.adb } }), {
    flag: 'wx',
  });
  report.config = await fileIdentity(config);
  const manifest = JSON.parse(await readFile(join(snapshot, 'manifest.json'), 'utf8'));
  assert.deepEqual(
    [
      manifest.id,
      manifest.protocol_version,
      manifest.performance?.api_version,
      manifest.performance?.device_observation,
    ],
    ['android-device', 4, 2, true],
  );
  manifest.executable = join(snapshot, binaryNames[1]);
  host = await prepareHost({
    root,
    binary: join(snapshot, binaryNames[0]),
    directory: join(directory, 'data'),
    report,
    port: await reservePort(),
    performancePlugin: 'android-device',
  });
  await host.ready();
  const deployment = join(host.plugins, 'android-device');
  await mkdir(deployment);
  await writeFile(join(deployment, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx' });
  observer = observeTools(fixture, join(snapshot, binaryNames[4]), manifest.executable, report);
  const loaded = await host.client.post('/api/v2/plugins/android-device/load');
  assert.equal(loaded.state, 'loaded');
  await host.client.post('/api/v2/device-providers/android-device/refresh', {
    generation: loaded.generation,
  });
  frontend = await actualFrontend(host, report, frontendRoot);
  stage = '原 OEM 字段与实际前端消费';
  const started = await frontend.start(
      {
        target: { device_id: deviceId, package: packageName },
        interval_ms: 1000,
        duration_secs: 120,
      },
      AbortSignal.timeout(10000),
    ),
    session = started.data;
  assert.equal(session.source.plugin_id, 'android-device');
  assert.equal(session.source.device.local_id, deviceId);
  assert.equal(session.source.generation, loaded.generation);
  report.sessions.push(session);
  await poll(
    async () => {
      observer.assertHealthy();
      const page = await operation(
        host,
        report,
        'samples',
        { session_id: session.id, after: 0, limit: 100 },
        'mcp',
      );
      page.readings.forEach(assertReading);
      return page;
    },
    (page) => page.readings.length >= 1,
    'OEM 原值样本',
    15000,
  );
  const stopped = await operation(host, report, 'stop', { session_id: session.id }, 'mcp');
  assert.equal(stopped.state, 'stopped');
  const page = await operation(host, report, 'samples', {
    session_id: session.id,
    after: 0,
    limit: 100,
  });
  assert.deepEqual(page.session, stopped);
  assert.ok(page.readings.length);
  page.readings.forEach(assertReading);
  report.checks.push({
    name: '逐字 OEM stdout 恢复标准电压/充电/外部供电/34.1温度，不猜电流或净功率',
    passed: true,
  });
  await frontend.select(session.id, AbortSignal.timeout(10000));
  const consumed = await frontend.samples(
    session.id,
    { after: 0, limit: 100 },
    AbortSignal.timeout(10000),
  );
  assert.deepEqual(consumed.data, page);
  assert.deepEqual(frontend.snapshot().readings, page.readings);
  frontend.dispose();
  frontend = undefined;
  report.frontend_consumed = consumed.data;
  report.checks.push({ name: 'HTTP/MCP 与实际前端消费同一电气资格、温度及空功率', passed: true });
  assert.equal((await host.client.post('/api/v2/plugins/android-device/unload')).state, 'unloaded');
  const history = await operation(
    host,
    report,
    'samples',
    { session_id: session.id, after: 0, limit: 100 },
    'mcp',
  );
  assert.deepEqual(history, page);
  report.history.push(history);
  report.checks.push({ name: '停采并卸载后原样本历史与来源代次保持', passed: true });
  stage = '正常退出、原 OS 句柄与身份';
  await host.shutdown();
  await observer.finish();
  observer = undefined;
  await host.verifyIdentity();
  await verifyFrontend(report);
  for (const tool of report.tools) {
    const ready = JSON.parse(await readFile(join(tool.directory, 'process.ready.json'), 'utf8')),
      exited = JSON.parse(await readFile(join(tool.directory, 'process.exit.json'), 'utf8'));
    assert.deepEqual(ready, tool.probe_ready);
    assert.deepEqual(exited, tool.process.exit);
    assert.equal(tool.process.probe_exit.code, 0);
    for (const role of ['target', 'parent'])
      assert.equal(ready[role].creation_time_100ns, exited[role].creation_time_100ns);
    if (['battery', 'uevent', 'thermal'].includes(tool.category))
      assert.deepEqual(
        await readFile(join(tool.directory, 'stdout.bin')),
        Buffer.from(tool.category === 'battery' ? original.stdout : ''),
      );
  }
  assert.ok(
    report.tools.some((tool) => tool.category === 'battery') &&
      report.tools.some((tool) => tool.category === 'uevent'),
    'AD-OBS-OEM-REPLAY-EXECUTED',
  );
  report.inputs_after = await inputManifest(fileURLToPath(import.meta.url), inputPaths);
  assert.deepEqual(report.inputs_after, report.inputs_before);
  for (const entry of report.snapshots)
    assert.deepEqual(await fileIdentity(entry.actual.path), entry.actual);
  for (const entry of fixtureInputs) assert.deepEqual(await fileIdentity(entry.path), entry);
  assert.deepEqual(await fileIdentity(config), report.config);
  report.checks.push({
    name: '工具与父插件原句柄退出、宿主exit0/端口释放，输入与重放字节前后稳定',
    passed: true,
  });
  report.passed = true;
} catch (error) {
  failure(report, error, stage);
} finally {
  try {
    frontend?.dispose();
  } catch (error) {
    failure(report, error, '释放实际前端');
  }
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
      sessions: report.sessions.length,
      tools: report.tools.length,
    }),
  );
  process.exitCode = report.passed ? 0 : 1;
}
