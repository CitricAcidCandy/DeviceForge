import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareHost, reservePort } from '../android-packages-smoke/host.mjs';
import { poll } from '../device-provider/client.mjs';
import {
  canonicalArgv,
  prepareFixture,
  setMode,
  verifyFixture,
} from '../android-profile-smoke/fixtures.mjs';
import { finishPendingProbes, observeTools } from '../android-profile-smoke/processes.mjs';
import { contract as fpsContract } from '../android-game-fps-smoke/route.mjs';
import {
  assertReading as assertFps,
  deviceId,
  packageName,
} from '../android-game-fps-smoke/fixtures.mjs';
import { operation } from './cases.mjs';
import { actualFrontend, freezeFrontend, verifyFrontend } from './frontend.mjs';
import { failure, fileIdentity, inputManifest, retain, writeJsonBatches } from './evidence.mjs';

// 只在固定只读命令中重放明确拒绝；FPS 复用独立手工官方字段黄金，不镜像生产解析器。
const args = process.argv.slice(2),
  names = ['--frozen-input', '--plugin-input', '--tool', '--probe'];
if (args.length === 1 && args[0] === '--help') {
  console.log(
    'node scripts/android-device-observation-smoke/partial-metrics.mjs --frozen-input=宿主冻结目录 --plugin-input=插件冻结目录 --tool=已有profile原生假ADB --probe=OS探针',
  );
  process.exit(0);
}
assert.ok(
  args.every((value) => names.some((name) => value.startsWith(name + '='))),
  'PARTIAL-METRICS-ARGUMENT',
);
const option = (name) => {
  const values = args.filter((value) => value.startsWith(name + '='));
  assert.equal(values.length, 1, 'PARTIAL-METRICS-EXPLICIT-INPUT');
  assert.ok(values[0].slice(name.length + 1));
  return resolve(values[0].slice(name.length + 1));
};
const root = fileURLToPath(new URL('../../', import.meta.url)),
  frozen = option(names[0]),
  pluginFrozen = option(names[1]);
const directory = join(root, 'artifacts', 'android-partial-metrics-debug-' + randomUUID()),
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
  scope: '系统CPU或内存明确拒绝时其余原值、HTTP/MCP/实际前端、停采卸载历史与原OS退出',
  limitations: [
    '原生固定输出不证明真机权限、OEM接口或传感器精度',
    '原OS句柄仅证明直接工具和父插件，不证明远端进程或派生树',
    '本批不运行性能专项、浏览器页面、Release或分发验收',
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
    'Current Battery Service state:\n  AC powered: false\n  USB powered: false\n  Wireless powered: false\n  Dock powered: false\n  status: 3\n  present: true\n  voltage: 4200\n  temperature: 317\n',
  thermal:
    'HAL Ready: true\nCurrent temperatures from HAL:\n  Temperature{mValue=47.25, mType=1, mName=gpu0, mStatus=2}\nCurrent cooling devices from HAL:\n',
};
const unavailable = {
  memory: { source: 'android_dumpsys.meminfo', stderr: 'dumpsys: meminfo: Permission denied\n' },
  system: { source: 'linux_proc.stat', stderr: 'cat: /proc/stat: Permission denied\n' },
};
const base = fpsContract.cases.find((value) => value.id === 'valid-bare');
assert.ok(base);
function convert(spec) {
  return {
    ...spec,
    argv: [...spec.argv],
    outputs: spec.outputs.map((value) => ({
      stdout: Buffer.from(
        Object.hasOwn(environmental, spec.category) ? environmental[spec.category] : value,
      ),
      stderr: Buffer.alloc(0),
      exit: 0,
    })),
  };
}
const contract = {
  ...fpsContract,
  route: '冻结FPS父链黄金与明确CPU/内存拒绝',
  shared: fpsContract.shared
    .filter((spec) => !Object.hasOwn(unavailable, spec.category))
    .map(convert),
  cases: [
    ['mem-permission', 'memory', 'memPermission'],
    ['system-permission', 'system', 'systemPermission'],
  ].map(([id, missingCategory, name]) => ({
    ...base,
    id,
    name,
    missing_category: missingCategory,
    expected: structuredClone(base.expected),
    commands: [
      ...base.commands.map(convert),
      ...fpsContract.shared
        .filter((spec) => Object.hasOwn(unavailable, spec.category))
        .map((spec) => {
          const result = convert(spec);
          if (spec.category === missingCategory)
            result.outputs = [
              {
                stdout: Buffer.alloc(0),
                stderr: Buffer.from(unavailable[missingCategory].stderr),
                exit: 1,
              },
            ];
          return result;
        }),
    ],
  })),
};
function assertPartialReading(reading, scenario) {
  assertFps(reading, scenario.expected[0]);
  assert.equal(reading.pid, 2468);
  const missing = reading.metric_missing;
  assert.ok(missing);
  assert.equal(missing.api_version, 1);
  const absent = scenario.missing_category === 'system' ? 'cpu' : 'memory',
    other = absent === 'cpu' ? 'memory' : 'cpu';
  assert.deepEqual(missing[absent], {
    source: unavailable[scenario.missing_category].source,
    access: 'adb_shell',
    reason: 'permission_denied',
  });
  assert.equal(missing[other] ?? null, null, 'PARTIAL-METRICS-ONLY-UNAVAILABLE-ITEM');
  if (absent === 'memory') {
    assert.equal(reading.logical_cpus, 2);
    assert.equal(reading.pss_kib, null);
    assert.equal(reading.rss_kib, null);
  } else {
    assert.equal(reading.logical_cpus, null);
    assert.equal(reading.cpu_share_percent, null);
    assert.equal(reading.cpu_core_percent, null);
    assert.equal(reading.pss_kib, 2048);
    assert.equal(reading.rss_kib, 4096);
  }
  const observation = reading.device_observation;
  assert.ok(observation);
  assert.deepEqual(
    [observation.api_version, observation.scope, observation.device_id],
    [1, 'device', deviceId],
  );
  const battery = observation.battery;
  assert.ok(battery);
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
      access: 'adb_shell',
      voltage_uv: 4000000,
      current_ua: -500000,
      current_polarity: 'positive_charging',
      status: 'discharging',
      supply_state: 'battery',
    },
  );
  assert.equal(reading.battery_net_power_mw, -2000);
  const temperatures = [
    {
      source: 'thermal_hal_current',
      access: 'adb_shell',
      sensor_kind: 'gpu',
      sensor_name: 'gpu0',
      sensor_type: 1,
      temperature_celsius: 47.25,
      status: 2,
    },
    {
      source: 'battery_dumpsys',
      access: 'adb_shell',
      sensor_kind: 'battery',
      sensor_name: 'battery',
      sensor_type: null,
      temperature_celsius: 31.7,
      status: null,
    },
  ];
  assert.equal(observation.temperatures.length, temperatures.length);
  for (const expected of temperatures) {
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
        value.observed_at <= reading.captured_at &&
        value.observed_at >= reading.captured_at - 10000,
    );
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
];
try {
  assert.equal(process.platform, 'win32', 'PARTIAL-METRICS-WINDOWS-OS-HANDLE');
  const frontendRoot = await freezeFrontend(root, join(snapshot, 'frontend'), report);
  inputPaths = [
    ...sources,
    join(root, 'scripts/android-profile-smoke/fake-adb.rs'),
    ...report.frontend_snapshots.map((item) => item.source.path),
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
      manifest.performance?.fps,
      manifest.performance?.device_observation,
      manifest.performance?.partial_metrics,
    ],
    ['android-device', 4, 2, true, true, true],
  );
  manifest.executable = join(snapshot, 'deviceforge-android-device-plugin.exe');
  host = await prepareHost({
    root,
    binary: join(snapshot, 'apk-server.exe'),
    directory: join(directory, 'data'),
    report,
    port: await reservePort(),
    performancePlugin: 'android-device',
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
  await host.client.post('/api/v2/device-providers/android-device/refresh', {
    generation: loaded.generation,
  });
  frontend = await actualFrontend(host, report, frontendRoot);
  for (const [index, scenario] of fixture.cases.entries()) {
    stage = scenario.name + '停采与前端';
    await setMode(fixture, scenario.id);
    observer.assertHealthy();
    host.assertRunning();
    const started = await frontend.start(
      {
        target: { device_id: deviceId, package: packageName },
        interval_ms: 1000,
        duration_secs: 120,
      },
      AbortSignal.timeout(10000),
    );
    const session = started.data;
    assert.deepEqual(
      [session.source.plugin_id, session.source.device.local_id, session.source.generation],
      ['android-device', deviceId, loaded.generation],
    );
    report.sessions.push({ ...session, case_id: scenario.id });
    await poll(
      async () => {
        observer.assertHealthy();
        host.assertRunning();
        const page = await operation(
          host,
          report,
          'samples',
          { session_id: session.id, after: 0, limit: 100 },
          'mcp',
        );
        page.readings.forEach((reading) => assertPartialReading(reading, scenario));
        return page;
      },
      (page) => page.readings.length >= 1,
      scenario.name + '合格部分缺测样本',
      15000,
    );
    // 首样本出现后立即停采；不额外等待绕过握手取消或清理失败。
    const stopped = await operation(
      host,
      report,
      'stop',
      { session_id: session.id },
      index === 0 ? 'mcp' : 'http',
    );
    assert.equal(stopped.state, 'stopped');
    const input = { session_id: session.id, after: 0, limit: 100 },
      page = await operation(host, report, 'samples', input);
    assert.deepEqual(page.session, stopped);
    assert.ok(page.readings.length >= 1);
    page.readings.forEach((reading) => assertPartialReading(reading, scenario));
    assert.deepEqual(await operation(host, report, 'samples', input, 'mcp'), page);
    await frontend.select(session.id, AbortSignal.timeout(10000));
    const consumed = await frontend.samples(
      session.id,
      { after: 0, limit: 100 },
      AbortSignal.timeout(10000),
    );
    assert.deepEqual(consumed.data, page);
    assert.deepEqual(frontend.snapshot().readings, page.readings);
    report.history.push({ case_id: scenario.id, input, page, frontend_consumed: consumed.data });
    report.checks.push({
      name: scenario.name + '仅对应指标及原因缺测，FPS60/温度/电气原值经HTTP/MCP/实际前端保真',
      passed: true,
    });
  }
  frontend.dispose();
  frontend = undefined;
  observer.assertHealthy();
  host.assertRunning();
  assert.equal((await host.client.post('/api/v2/plugins/android-device/unload')).state, 'unloaded');
  for (const history of report.history)
    assert.deepEqual(await operation(host, report, 'samples', history.input, 'mcp'), history.page);
  report.checks.push({ name: '两会话停采卸载后历史、原因和插件来源代次完整保持', passed: true });
  stage = '正常退出与原OS句柄';
  await host.shutdown();
  await observer.finish();
  observer = undefined;
  await host.verifyIdentity();
  await verifyFrontend(report);
  for (const scenario of fixture.cases) {
    const tools = report.tools.filter((value) => value.mode === scenario.id);
    for (const category of [
      'memory',
      'system',
      'surface-proto',
      'latency',
      'uevent',
      'battery',
      'thermal',
    ])
      assert.ok(tools.some((value) => value.category === category));
    for (const tool of tools.filter((value) => value.category === scenario.missing_category))
      assert.equal(tool.planned_exit, 1);
  }
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
    assert.equal(exited.target.exit_code, output.exit);
    assert.equal(exited.parent.exit_code, 0);
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
    name: '明确拒绝stderr/exit1与其他stdout逐字固定，原OS工具/插件exit与宿主exit0/端口释放通过，输入前后SHA一致',
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
