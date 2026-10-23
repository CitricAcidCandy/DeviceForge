import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareHost, reservePort } from './mirroring-cleanup-fallback-smoke/host.mjs';
import { fileIdentity } from './unified-discovery-smoke/evidence.mjs';
import { poll } from './device-provider/client.mjs';
import { finishPendingProbes } from './harmony-screenshot-smoke/fixtures.mjs';
import { scenarios, failedScenarios, prepareCase, fixtureState, waitActualMedia,
  assertCaseState } from './mirroring-cleanup-fallback-smoke/fixtures.mjs';
import { observeTools } from './mirroring-cleanup-fallback-smoke/processes.mjs';
import { sessionSummary, failureSummary, verifyLogs, verifyFixturePorts,
  verifyBudget } from './mirroring-cleanup-fallback-smoke/evidence.mjs';

const args = process.argv.slice(2);
const names = ['--frozen-input', '--plugin-input', '--tool', '--probe', '--case', '--server-version'];
const option = (name) => args.find((value) => value.startsWith(name + '='))?.slice(name.length + 1);
if (args.length === 1 && args[0] === '--help') {
  console.log('独立进程验收入口：node scripts/mirroring-cleanup-fallback-smoke.mjs --frozen-input=<宿主目录> --plugin-input=<新插件目录> --tool=<本驱动fake-adb.exe> --probe=<process-probe.exe> [--case=all|' + scenarios.join('|') + '] [--server-version=3.3.4|3.3.1]');
} else {
  assert.ok(args.every((value) => names.some((name) => value.startsWith(name + '='))), '存在未知参数');
  for (const name of names) assert.ok(args.filter((value) => value.startsWith(name + '=')).length <= 1, '参数重复：' + name);
  for (const name of names.slice(0, 4)) assert.ok(option(name), '必须显式提供：' + name);
  const selected = option('--case') ?? 'all';
  assert.ok(selected === 'all' || scenarios.includes(selected), '案例参数无效');
  const version = option('--server-version') ?? '3.3.4';
  assert.ok(['3.3.4', '3.3.1'].includes(version));
  await run(selected === 'all' ? scenarios : [selected], version);
}

async function isolatedPort() {
  const port = await reservePort();
  assert.ok(![7031, 5173].includes(port), '禁止使用用户现场端口');
  return port;
}

async function run(selected, version) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const runId = randomUUID();
  const directory = join(root, 'artifacts', 'mirroring-cleanup-fallback-smoke-' + runId);
  const snapshot = join(directory, 'snapshot');
  const report = {
    timestamp: new Date().toISOString(), run_id: runId, passed: false,
    selected_cases: selected, server_version: version, cases: [], inputs: [],
    scope: '隔离冻结宿主、独立插件、真实fake ADB进程与TCP、HTTP/MCP清理重试及保护标记',
    limitations: [
      '模拟远端状态与合成DFML不证明真机清理、视频解码、音频、WebRTC或完整媒体成功',
      'OS证据仅覆盖直接工具/插件、独占宿主及探针，不外推任意派生进程树',
      '2秒黑盒观察包括进程与探针开销；精确共用绝对期限由worker假runner单测确认',
      '不操作用户7031/5173、用户ADB/HDC、手机、旧fixture或生产cleanup_failed标记',
    ],
  };
  await mkdir(snapshot, { recursive: true });
  let stage = '冻结输入';
  try {
    assert.equal(process.platform, 'win32', '原始OS句柄探针仅支持Windows');
    const source = {
      'apk-server.exe': join(resolve(option('--frozen-input')), 'apk-server.exe'),
      'deviceforge-mirroring-plugin.exe': join(resolve(option('--plugin-input')), 'deviceforge-mirroring-plugin.exe'),
      'manifest.json': join(resolve(option('--plugin-input')), 'manifest.json'),
      'fake-adb.exe': resolve(option('--tool')),
      'process-probe.exe': resolve(option('--probe')),
    };
    assert.notEqual(source['fake-adb.exe'].toLowerCase(), source['apk-server.exe'].toLowerCase());
    for (const [name, path] of Object.entries(source)) {
      const before = await fileIdentity(path);
      const destination = join(snapshot, name);
      await copyFile(path, destination);
      const actual = await fileIdentity(destination);
      assert.equal(actual.sha256, before.sha256);
      report.inputs.push({ before, actual });
    }
    report.driver_inputs = [];
    for (const path of [
      fileURLToPath(import.meta.url),
      ...['fake-adb.rs', 'fixtures.mjs', 'processes.mjs', 'evidence.mjs', 'host.mjs'].map((name) => join(root, 'scripts/mirroring-cleanup-fallback-smoke', name)),
      join(root, 'scripts/mirroring-webrtc-smoke/socket_server.rs'),
      join(root, 'scripts/mirroring-streaming-smoke/fixtures.mjs'),
      join(root, 'scripts/mirroring-streaming-smoke/golden.mjs'),
      join(root, 'scripts/harmony-screenshot-smoke/process-probe.rs'),
    ]) report.driver_inputs.push(await fileIdentity(path));
    const manifest = JSON.parse(await readFile(join(snapshot, 'manifest.json'), 'utf8'));
    assert.equal(manifest.id, 'mirroring');
    assert.equal(manifest.sessions?.protocol_version, 5);
    assert.ok(manifest.sessions.operations.some((entry) => entry.name === 'open'));
    for (const scenario of selected) {
      stage = '执行独立案例：' + scenario;
      const current = await runCase({ root, snapshot, directory, scenario, version, manifest, runId });
      report.cases.push(current);
      // 每例宿主已独立退出再继续；失败原件不覆盖，保护标记也不跨例复用。
      if (current.cleanup_errors?.length) break;
    }
    report.passed = report.cases.length === selected.length && report.cases.every((entry) => entry.passed);
  } catch (error) {
    report.failure = failureSummary(error, stage);
  } finally {
    try {
      for (const entry of report.inputs) {
        entry.after = await fileIdentity(entry.before.path);
        assert.equal(entry.after.sha256, entry.before.sha256);
        assert.equal(entry.after.bytes, entry.before.bytes);
      }
      for (const before of report.driver_inputs ?? []) assert.deepEqual(await fileIdentity(before.path), before);
      report.inputs_stable = true;
    } catch (error) {
      report.inputs_stable = false;
      report.passed = false;
      report.identity_failure = failureSummary(error, '输入摘要收尾');
    }
    report.completed_at = new Date().toISOString();
    await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log(JSON.stringify({ directory, passed: report.passed,
      cases: report.cases.map(({ scenario, passed, failure }) => ({ scenario, passed, failure })) }));
    if (!report.passed) process.exitCode = 1;
  }
}

async function runCase({ root, snapshot, directory, scenario, version, manifest, runId }) {
  const caseDirectory = join(directory, scenario);
  const report = { scenario, timestamp: new Date().toISOString(), passed: false,
    checks: [], requests: [], sessions: [], tools: [], cleanup_errors: [] };
  let host, fixture, observer;
  let stage = '准备独占夹具';
  await mkdir(caseDirectory, { recursive: true });
  const cleanupError = (error, phase) => report.cleanup_errors.push(failureSummary(error, phase));
  try {
    fixture = await prepareCase(caseDirectory, join(snapshot, 'fake-adb.exe'), scenario, version, runId);
    const config = join(caseDirectory, 'mirroring.config.json');
    await writeFile(config, JSON.stringify({ format_version: 1, scrcpy: fixture.adb, adb: fixture.adb,
      live: { scrcpy_server: fixture.server, server_version: version } }), { flag: 'wx' });
    host = await prepareHost({ root, binary: join(snapshot, 'apk-server.exe'),
      directory: join(caseDirectory, 'data'), report, port: await isolatedPort() });
    stage = '独占宿主就绪';
    await host.ready();
    const deployment = join(host.plugins, 'mirroring');
    await mkdir(deployment);
    const deployed = { ...manifest, executable: join(snapshot, 'deviceforge-mirroring-plugin.exe'), args: ['--config', config] };
    await writeFile(join(deployment, 'manifest.json'), JSON.stringify(deployed), { flag: 'wx' });
    const loaded = await host.client.post('/api/v2/plugins/mirroring/load');
    assert.equal(loaded.state, 'loaded');
    assert.equal(loaded.cleanup_failed, false);
    report.generation = loaded.generation;
    observer = observeTools(fixture, join(snapshot, 'process-probe.exe'), deployed.executable, report);

    const openAndCancel = async (device, transport, expectedCleanup) => {
      stage = '打开实际媒体会话：' + device;
      const input = { device_id: device, audio: false, control: false, reconnect_attempts: 0,
        max_size: 1024, max_fps: 30, video_bit_rate: 4000000 };
      const opened = transport === 'http'
        ? await host.client.post('/api/v2/sessions', { operation: 'plugin.mirroring.open', input }, { status: 202 })
        : await host.client.tool('plugin.mirroring.open', input);
      const entry = { ...sessionSummary(opened), transport,
        log_id: report.last_request.log_id, expected_cleanup: expectedCleanup, device };
      report.sessions.push(entry);
      assert.equal(opened.generation, loaded.generation);
      await waitActualMedia(host, fixture, opened.id, device);
      observer.assertHealthy();
      entry.before_cancel = await fixtureState(fixture, device);
      stage = '取消与清理终态：' + device;
      entry.cancel_requested_at = new Date().toISOString();
      if (transport === 'http') await host.client.post(`/api/v2/sessions/${opened.id}/cancel`);
      else await host.client.tool('deviceforge.cancel_session', { id: opened.id });
      const finished = await poll(() => host.client.json(`/api/v2/sessions/${opened.id}`),
        (info) => info.status === 'finished', '取消后的终态');
      entry.final = sessionSummary(finished);
      entry.terminal_observed_at = new Date().toISOString();
      entry.after_cancel = await fixtureState(fixture, device);
      assert.equal(finished.completion.process_exited, true);
      assert.deepEqual(sessionSummary(await host.client.tool('deviceforge.get_session', { id: opened.id })), entry.final);
      entry.server_exit = await observer.verifyServerExit(device);
      assert.equal(finished.completion.cleanup, expectedCleanup);
      return entry;
    };

    const expected = failedScenarios.has(scenario) ? 'failed' : 'complete';
    await openAndCancel(fixture.device, 'http', expected);
    stage = '同代准入及持久保护';
    const current = (await host.client.json('/api/v2/plugins')).find((entry) => entry.id === 'mirroring');
    report.plugin_after_cancel = { id: current.id, generation: current.generation,
      state: current.state, cleanup_failed: current.cleanup_failed };
    assert.equal(current.generation, loaded.generation);
    if (expected === 'complete') {
      assert.equal(current.cleanup_failed, false);
      await host.client.post(`/api/v2/sessions/${report.sessions[0].id}/release`, undefined, { status: 202 });
      const next = await openAndCancel(fixture.nextDevice, 'mcp', 'complete');
      await host.client.tool('deviceforge.release_session', { id: next.id });
      const final = (await host.client.json('/api/v2/plugins')).find((entry) => entry.id === 'mirroring');
      assert.equal(final.cleanup_failed, false);
      assert.equal(final.generation, loaded.generation);
      report.checks.push({ name: '清理Complete且同代新MCP会话重新准入并清理', passed: true });
    } else {
      assert.equal(current.cleanup_failed, true);
      const denied = await host.client.call('/api/v2/sessions', { method: 'POST',
        body: JSON.stringify({ operation: 'plugin.mirroring.open', input: { device_id: fixture.nextDevice, audio: false, control: false } }) });
      assert.equal(denied.status, 409);
      assert.equal(denied.body.error.code, 'cleanup_failed');
      const mcpDenied = await host.client.tool('plugin.mirroring.open',
        { device_id: fixture.nextDevice, audio: false, control: false }, 'cleanup_failed');
      report.denied = { http_status: denied.status, http_code: denied.body.error.code,
        http_log_id: denied.logId, mcp_code: mcpDenied.code, mcp_log_id: report.last_request.log_id };
      const unload = await host.client.call('/api/v2/plugins/mirroring/unload', { method: 'POST' });
      assert.equal(unload.status, 409);
      assert.equal(unload.body.error.code, 'cleanup_failed');
      const reload = await host.client.call('/api/v2/plugins/mirroring/load', { method: 'POST' });
      assert.equal(reload.status, 409);
      assert.equal(reload.body.error.code, 'conflict');
      const protectedPlugin = (await host.client.json('/api/v2/plugins')).find((entry) => entry.id === 'mirroring');
      assert.equal(protectedPlugin.cleanup_failed, true);
      assert.equal(protectedPlugin.state, 'draining');
      assert.equal(report.tools.some((entry) => entry.argv[1] === fixture.nextDevice), false);
      report.lifecycle = { unload: { status: unload.status, code: unload.body.error.code },
        reload: { status: reload.status, code: reload.body.error.code },
        cleanup_failed: protectedPlugin.cleanup_failed, state: protectedPlugin.state };
      report.checks.push({ name: '失败保留cleanup_failed、HTTP/MCP拒绝准入、卸载重载仍409', passed: true });
    }
    stage = '正常关闭独占宿主';
    await host.shutdown();
    await observer.finish();
    observer = undefined;
    report.fixture_final = await assertCaseState(fixture, scenario, report.tools);
    if (scenario === 'shared-budget') verifyBudget(report, fixture.device);
    await verifyLogs(caseDirectory, host, report);
    await host.verifyIdentity();
    report.checks.push({ name: '本次真实工具OS退出、远端状态及全局命令禁用', passed: true });
    report.passed = true;
  } catch (error) {
    report.failure = failureSummary(error, stage);
  } finally {
    // 原始失败不被shutdown覆盖；仅本轮fake ADB识别退出标记，未知PID不被操作。
    if (fixture && !report.passed) {
      try { await writeFile(join(fixture.root, 'stop-fixture'), '1', { flag: 'wx' }); }
      catch (error) { cleanupError(error, '仅本轮夹具自退标记'); }
    }
    if (host) {
      try { await host.finish(); } catch (error) { cleanupError(error, '独占宿主收尾'); }
    }
    if (observer) {
      try { await observer.finish(); } catch (error) { cleanupError(error, '本次直接工具及探针退出'); }
      await observer.stop();
    }
    try { await finishPendingProbes(report); } catch (error) { cleanupError(error, '剩余自有探针回收'); }
    if (fixture) {
      try {
        report.retained_fixture = await fixtureState(fixture, fixture.device);
        await verifyFixturePorts(fixture, report);
      } catch (error) { cleanupError(error, '夹具状态及端口回收'); }
    }
    if (report.cleanup_errors.length) report.passed = false;
    report.process_recovery = {
      host: report.hosts?.map(({ pid, exit, graceful_shutdown, forced_direct_child_termination }) =>
        ({ pid, command: '本轮冻结apk-server.exe', exit, graceful_shutdown, forced_direct_child_termination })),
      tools: report.tools.map(({ pid, category, probe_pid, process: evidence }) => ({ pid,
        command: '本轮fake-adb.exe/' + category, exited: evidence?.exit.target.state === 'exited',
        plugin_pid: evidence?.exit.parent.pid, plugin_exited: evidence?.exit.parent.state === 'exited',
        probe_pid, probe_exit: evidence?.probe_exit })),
      user_processes_touched: false,
    };
    report.completed_at = new Date().toISOString();
    await writeFile(join(caseDirectory, 'report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  }
  return report;
}
