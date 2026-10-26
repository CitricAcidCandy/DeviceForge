import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { poll } from '../device-provider/client.mjs';
import { finishPendingProbes } from '../harmony-screenshot-smoke/fixtures.mjs';
import { prepareHost, reservePort } from './host.mjs';
import { observeFaultWorkers } from './fault-processes.mjs';
import { observeTools } from './processes.mjs';
import { prepareRecoveryFixture, fixtureState, verifyPorts } from './fixtures.mjs';
import { assertRecoveryView, recoveryPath, recoverySummary } from './http.mjs';
import { failureSummary, fileIdentity, processSummary, sessionSummary, verifyLogs } from './evidence.mjs';
import { readIfExists } from './fixtures.mjs';

const invalidModes = [
  'coverage-omitted', 'coverage-empty', 'coverage-device', 'inspected-omitted',
  'remaining-omitted', 'checks-empty', 'remaining-positive',
];

// 使用真实宿主与独立协议故障进程验证宿主边界，不计为生产插件台账验收。
export async function runFaultCase({ snapshot, directory, definition, manifest, runId, completionRecovery }) {
  const name = definition.name, caseDirectory = join(directory, name), faultRoot = join(caseDirectory, 'fault');
  const report = { scenario: name, status: 'running', passed: false, scope: '真实宿主及受控协议故障进程；不是生产投屏插件',
    timestamp: new Date().toISOString(), checks: [], requests: [], sessions: [], tools: [],
    recovery_views: [], cleanup_errors: [], fault_workers: [] };
  let host, observer, stage = '准备独立协议故障目录';
  let fixture, toolObserver;
  const cleanupError = (error, phase) => report.cleanup_errors.push(failureSummary(error, phase));
  await mkdir(faultRoot, { recursive: true });
  await writeFile(join(faultRoot, 'fault-fixture-owner'), runId, { flag: 'wx' });
  await writeFile(join(faultRoot, 'mode'), 'coverage-omitted', { flag: 'wx' });
  try {
    host = await prepareHost({ binary: join(snapshot, 'apk-server.exe'),
      directory: join(caseDirectory, 'data'), report, port: await reservePort() });
    await host.ready();
    const deployment = join(host.plugins, 'mirroring');
    await mkdir(deployment);
    const executable = join(deployment, 'fault-worker.mjs');
    await copyFile(fileURLToPath(new URL('./fault-worker.mjs', import.meta.url)), executable);
    const deployed = structuredClone(manifest);
    Object.assign(deployed, { executable: process.execPath, args: [executable, '--root=' + faultRoot] });
    if (name === 'legacy-empty-global') {
      const bin = join(deployment, 'bin'); await mkdir(bin);
      const actual = join(bin, 'deviceforge-mirroring-plugin.exe');
      await copyFile(join(snapshot, 'deviceforge-mirroring-plugin.exe'), actual);
      fixture = await prepareRecoveryFixture(caseDirectory, join(snapshot, 'fake-adb.exe'), name, '3.3.4', runId);
      const plan = fixture.plan(fixture.device), token = '0123456789abcdef0123456789abcdef';
      for (const [field, value] of Object.entries({ 'expected-dir': '/data/local/tmp/deviceforge_' + token,
        'remote-dir': '/data/local/tmp/deviceforge_' + token, 'remote-pid': '7001', 'remote-owner': '11111111',
        'directory-owner': token, 'remote-start': '9001', 'remote-boot': '11111111-2222-4333-8444-555555555555', token }))
        await writeFile(join(plan, field), value, { flag: 'wx' });
      const config = join(caseDirectory, 'mirroring.config.json');
      await writeFile(config, JSON.stringify({ format_version: 1, scrcpy: fixture.adb, adb: fixture.adb,
        live: { scrcpy_server: fixture.server, server_version: '3.3.4' } }), { flag: 'wx' });
      deployed.args.push('--recover-binary=' + actual, '--recover-config=' + config);
      report.actual_plugin = await fileIdentity(actual);
      report.legacy_without_ledger = { resource_root: join(bin, '.mirroring-resources'),
        control_root: join(bin, '.mirroring-control'), before: await fixtureState(fixture, fixture.device) };
      toolObserver = observeTools(fixture, join(snapshot, 'process-probe.exe'), actual, report);
    }
    // 仅保留公开协议 5 的合成会话和恢复声明，避免借用生产业务贡献。
    deployed.operations = [];
    delete deployed.configuration; delete deployed.artifacts;
    deployed.sessions = { protocol_version: 5, operations: [{ name: 'open', title: '恢复故障夹具',
      input_schema: { type: 'object', properties: { device_id: { type: 'string' } }, required: ['device_id'] } }] };
    await writeFile(join(deployment, 'manifest.json'), JSON.stringify(deployed), { flag: 'wx' });
    report.deployment = { worker: await fileIdentity(executable),
      manifest: await fileIdentity(join(deployment, 'manifest.json')), node: await fileIdentity(process.execPath) };
    const loaded = await host.client.post('/api/v2/plugins/mirroring/load');
    report.generation = loaded.generation;
    observer = observeFaultWorkers(faultRoot, join(snapshot, 'process-probe.exe'), join(snapshot, 'apk-server.exe'), report);
    stage = '通过真实协议 5 进程制造清理风险';
    const active = await host.client.post('/api/v2/sessions', { operation: 'plugin.mirroring.open',
      input: { device_id: fixture?.device ?? 'synthetic-recovery-fault' } }, { status: 202 });
    report.sessions.push({ ...sessionSummary(active), log_id: report.requests.at(-1).log_id });
    await poll(() => host.client.json(`/api/v2/sessions/${active.id}/output?after=0&limit=100`),
      (page) => page.chunks.some((chunk) => chunk.stream === 'stdout' && Buffer.from(chunk.bytes).equals(Buffer.from([82]))),
      '故障进程已进入真实协议 5 业务');
    await host.client.post(`/api/v2/sessions/${active.id}/cancel`);
    const terminal = await poll(() => host.client.json(`/api/v2/sessions/${active.id}`),
      (value) => value.status === 'finished', '故障会话终态');
    assert.equal(terminal.completion.cleanup, 'failed');
    assert.equal(terminal.completion.process_exited, true);
    report.sessions[0].final = sessionSummary(terminal);
    await observer.verifyLatestExit('open');
    const view = async () => assertRecoveryView(await host.client.recovery(), { generation: loaded.generation, supported: true });
    assert.equal((await view()).cleanup_failed, true);
    if (completionRecovery) await poll(view, (value) => !value.recovering && value.last_report?.status === 'blocked',
      '故障协议会话结束后的一次自动恢复已结束', 38000);
    report.fault_modes = [];
    if (name === 'legacy-empty-global') {
      stage = '有真实宿主风险但无生产台账/控制状态，POST 空对象不能假全局成功';
      for (const path of [report.legacy_without_ledger.resource_root, report.legacy_without_ledger.control_root]) {
        let names;
        try { names = await readdir(path); } catch (error) { if (error.code !== 'ENOENT') throw error; names = []; }
        assert.equal(names.some((item) => item.endsWith('.json')), false, '不得借用台账或控制状态代替未知旧资源');
      }
      const reply = await host.client.call(recoveryPath, { method: 'POST', input: { generation: loaded.generation, input: {} } });
      const call = report.fault_workers.filter((item) => item.operation === 'runtime.recover').at(-1);
      assert.ok(call, '必须实际启动生产恢复插件');
      const forwardedExit = JSON.parse(await readFile(call.base + '.forwarded-exit.json', 'utf8'));
      assert.equal(forwardedExit.code, 0, '必须核对生产插件正常返回，不能以传输超时冒充旧资源被拒绝');
      assert.equal(forwardedExit.signal, null);
      report.forwarded_plugin_exit = forwardedExit;
      report.empty_input_result = { status: reply.status, log_id: reply.logId,
        report_status: reply.body.data?.last_report?.status, cleanup_failed: reply.body.data?.cleanup_failed };
      if (reply.status === 200) {
        const value = assertRecoveryView(reply.body.data, { generation: loaded.generation, supported: true, freshReport: true });
        assert.notEqual(value.last_report?.status, 'recovered', '未知旧资源不能在空目标下被宣布已恢复');
        assert.equal(value.cleanup_failed, true);
      } else assert.ok(reply.status >= 400 && reply.status < 600);
      assert.equal((await view()).cleanup_failed, true);
      const after = report.legacy_after = await fixtureState(fixture, fixture.device);
      for (const [key, before] of Object.entries(report.legacy_without_ledger.before)) {
        // 审计应增加只读查询次数；任何资源或清理、删除次数变化仍须失败。
        if (key === 'list_attempts') assert.ok(after[key] > before, '必须实际查询旧资源');
        else assert.deepEqual(after[key], before, '未知旧资源不得被修改：' + key);
      }
      report.checks.push('真实风险及无台账旧资源在空输入时保持阻断，未假装全插件恢复');
    }
    for (const mode of name === 'legacy-empty-global' ? [] : name === 'invalid-coverage' ? invalidModes : ['hanging-after-report']) {
      stage = '真实宿主恢复反例：' + mode;
      await writeFile(join(faultRoot, 'mode'), mode, 'utf8');
      const result = await host.client.call(recoveryPath, { method: 'POST', input: {
        generation: loaded.generation, input: { device_id: 'synthetic-recovery-fault' },
      } });
      observer.assertHealthy();
      if (result.status === 200) {
        const value = assertRecoveryView(result.body.data, { generation: loaded.generation, supported: true });
        assert.equal(value.cleanup_failed, true, '不合格报告或挂住进程不能清风险');
        assert.notEqual(value.last_report?.status, 'recovered');
      } else {
        assert.ok(result.status >= 400 && result.status < 600);
        assert.ok(result.body.error && typeof result.body.error.code === 'string');
      }
      const current = await view();
      assert.equal(current.cleanup_failed, true);
      assert.equal(current.recovering, false);
      assert.notEqual(current.last_report?.status, 'recovered');
      report.recovery_views.push(recoverySummary(current));
      const exited = await observer.verifyLatestExit('runtime.recover');
      const worker = report.fault_workers.at(-1);
      assert.equal((await readIfExists(worker.base + '.response-written'))?.toString('utf8'), mode,
        '必须证明故障响应实际写出，不能把未启动当作保护成功');
      if (mode === 'hanging-after-report') assert.notEqual(exited.target.exit_code, 0,
        '故意挂住的夹具不得自行正常退出冒充宿主监督');
      if (mode === 'hanging-after-report') assert.ok(![96, 97].includes(exited.target.exit_code),
        '不能由夹具自退看门狗代替宿主回收');
      report.fault_modes.push({ mode, status: result.status, log_id: result.logId,
        cleanup_failed: current.cleanup_failed, original_process_exited: exited.target.state === 'exited' });
    }
    stage = '故障反例后风险继续拦截新会话';
    // 已实测完整 30 秒的挂住监督；拒绝新会话时改用另一不合格报告，避免无意义重复挂住。
    // 风险仍由真实协议风险产生并保留，普通业务不能因此获得准入。
    if (name === 'hung-recovery-process') {
      await writeFile(join(faultRoot, 'mode'), 'coverage-omitted', 'utf8');
      report.continuation_fault = 'coverage-omitted';
    }
    const denied = name === 'legacy-empty-global' ? null : await host.client.call('/api/v2/sessions', { method: 'POST', input: {
      operation: 'plugin.mirroring.open', input: { device_id: 'synthetic-recovery-fault' },
    } });
    if (denied) assert.equal(denied.status, 409);
    assert.equal((await view()).cleanup_failed, true);
    stage = '正常关闭故障夹具宿主';
    await host.shutdown(); await observer.finish(); observer = undefined;
    if (toolObserver) { await toolObserver.finish(); toolObserver = undefined; }
    await verifyLogs(host, report); await host.verifyIdentity();
    report.checks.push('真实宿主拒绝不合格恢复确认，风险保留，原进程及端口已退出');
    report.status = 'passed'; report.passed = true;
  } catch (error) { report.status = 'failed'; report.failure = failureSummary(error, stage); }
  finally {
    if (!report.passed) {
      try { await writeFile(join(faultRoot, 'stop-fixture'), '1', { flag: 'wx' }); }
      catch (error) { cleanupError(error, '本轮故障进程自退标记'); }
      if (fixture) await writeFile(join(fixture.root, 'stop-fixture'), '1');
    }
    if (host) { try { await host.finish(); } catch (error) { cleanupError(error, '本轮故障宿主收尾'); } }
    if (observer) {
      try { await observer.finish(); } catch (error) { cleanupError(error, '故障进程原始句柄收尾'); }
      await observer.stop();
    }
    if (toolObserver) {
      try { await toolObserver.finish(); } catch (error) { cleanupError(error, '旧资源反例工具收尾'); }
      await toolObserver.stop();
    }
    if (fixture) {
      try { report.legacy_after = await fixtureState(fixture, fixture.device); await verifyPorts(fixture, report); }
      catch (error) { cleanupError(error, '旧资源反例夹具状态收尾'); }
    }
    try { await finishPendingProbes(report); } catch (error) { cleanupError(error, '故障探针兜底收尾'); }
    if (report.cleanup_errors.length) { report.passed = false; report.status = 'failed'; }
    report.process_recovery = { ...processSummary(report), fault_workers: report.fault_workers.map(({ pid, probe_pid, process: value }) => ({
      pid, command: '本轮 Node 协议故障进程', probe_pid,
      exited: value?.exit.target.state === 'exited', probe_exit: value?.probe_exit,
    })) };
    report.completed_at = new Date().toISOString();
    await writeFile(join(caseDirectory, 'report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  }
  return report;
}
