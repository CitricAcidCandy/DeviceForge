import assert from 'node:assert/strict';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareHost, reservePort } from './host.mjs';
import { prepareRecoveryFixture, fixtureState, setMode, verifyPorts } from './fixtures.mjs';
import { observeTools } from './processes.mjs';
import { finishPendingProbes } from '../harmony-screenshot-smoke/fixtures.mjs';
import { failureSummary, fileIdentity, processSummary, verifyLogs } from './evidence.mjs';
import { sessionDriver } from './sessions.mjs';
import { makeRisk, runScenario } from './cases.mjs';
import { archiveCleanSession } from './reset-fixture.mjs';
import { prepareBrowserProvider } from './browser-provider.mjs';
import { runRecoveryPanelBrowser } from './browser-case.mjs';
import { ledgerSnapshot } from './ledger.mjs';
import { prepareMedia } from './media.mjs';
import { runRecoveredWebrtc } from './webrtc-browser.mjs';

export async function runCase({ snapshot, directory, definition, manifest, version, runId, browserDist }) {
  const name = definition.name, caseDirectory = join(directory, name);
  const report = { scenario: name, status: 'running', passed: false,
    timestamp: new Date().toISOString(), checks: [], requests: [], sessions: [],
    tools: [], recovery_views: [], cleanup_errors: [] };
  const context = { name, report, stage: '准备独占资源' };
  let host, fixture, observer, providerObserver;
  await mkdir(caseDirectory, { recursive: true });
  const cleanupError = (error, phase) => report.cleanup_errors.push(failureSummary(error, phase));
  try {
    fixture = await prepareRecoveryFixture(caseDirectory, join(snapshot, 'fake-adb.exe'), name, version, runId);
    const config = join(caseDirectory, 'mirroring.config.json');
    await writeFile(config, JSON.stringify({ format_version: 1, scrcpy: fixture.adb, adb: fixture.adb,
      live: { scrcpy_server: fixture.server, server_version: version } }), { flag: 'wx' });
    const port = await reservePort();
    assert.ok(![7031, 5173].includes(port));
    host = await prepareHost({ binary: join(snapshot, 'apk-server.exe'),
      directory: join(caseDirectory, 'data'), report, port });
    context.stage = '等待独占真实宿主就绪';
    await host.ready();
    const deployment = join(host.plugins, 'mirroring'), bin = join(deployment, 'bin');
    await mkdir(bin, { recursive: true });
    const executable = join(bin, 'deviceforge-mirroring-plugin.exe');
    await copyFile(join(snapshot, 'deviceforge-mirroring-plugin.exe'), executable);
    const deployed = structuredClone(manifest);
    Object.assign(deployed, { executable, args: ['--config', config] });
    if (name === 'unsupported') delete deployed.recovery;
    await writeFile(join(deployment, 'manifest.json'), JSON.stringify(deployed), { flag: 'wx' });
    report.deployment = { binary: await fileIdentity(executable),
      manifest: await fileIdentity(join(deployment, 'manifest.json')),
      independent_plugin_directory: bin, independent_config: config };
    context.stage = '加载本例独占插件副本';
    const loaded = await host.client.post('/api/v2/plugins/mirroring/load');
    assert.equal(loaded.state, 'loaded');
    assert.equal(loaded.cleanup_failed, false);
    report.generation = loaded.generation;
    observer = observeTools(fixture, join(snapshot, 'process-probe.exe'), executable, report);
    Object.assign(context, { host, fixture, observer, generation: loaded.generation });
    context.leaseBinary = join(snapshot, 'lease-holder.exe');
    context.probeBinary = join(snapshot, 'process-probe.exe');
    context.sessions = sessionDriver(context);
    await runScenario(context);
    await ledgerSnapshot(context);
    if (browserDist) {
      context.stage = '已通过 HTTP 后，准备真实产品恢复面板';
      providerObserver = await prepareBrowserProvider(context, snapshot, caseDirectory);
      report.browsers = [];
      for (const target of ['selected', 'all']) {
        await archiveCleanSession(fixture, fixture.device);
        await setMode(fixture, fixture.device, 'list-always');
        await makeRisk(context);
        await setMode(fixture, fixture.device, 'success');
        const browserDirectory = join(caseDirectory, 'browser-' + target);
        await mkdir(browserDirectory);
        context.stage = '真实冻结生产页面恢复面板：' + target;
        const browser = await runRecoveryPanelBrowser({ host, dist: browserDist,
          device: target === 'all' ? null : fixture.device,
          directory: browserDirectory, generation: context.generation });
        report.browsers.push(browser);
        assert.equal(browser.passed, true);
        if (target === 'selected') {
          context.stage = '同一非空故障恢复后，真实浏览器 WebRTC 播放与释放';
          await archiveCleanSession(fixture, fixture.device);
          const webrtcDirectory = join(caseDirectory, 'recovered-webrtc'); await mkdir(webrtcDirectory);
          report.media = await prepareMedia(webrtcDirectory, fixture, fixture.device, report);
          report.webrtc = await runRecoveredWebrtc(context, webrtcDirectory);
        }
      }
      providerObserver.assertHealthy();
      report.checks.push('冻结生产页面真实点击恢复、网络及截图留证；视觉仍待独立审核');
    }
    context.stage = '正常停止独占宿主';
    await host.shutdown();
    await observer.finish();
    observer = undefined;
    if (providerObserver) { await providerObserver.finish(); providerObserver = undefined; }
    await verifyLogs(host, report);
    await host.verifyIdentity();
    assert.deepEqual(await fileIdentity(executable), report.deployment.binary, '插件字节不能被夹具修改');
    report.checks.push('本例宿主、工具、插件与探针退出；响应日志关联原件');
    report.passed = true;
    report.status = 'passed';
  } catch (error) {
    report.failure = failureSummary(error, context.stage);
    report.status = 'failed';
  } finally {
    if (fixture && !report.passed) {
      try { await writeFile(join(fixture.root, 'stop-fixture'), '1', { flag: 'wx' }); }
      catch (error) { cleanupError(error, '本例 fake-adb 自退标记'); }
    }
    if (report.browser_provider && !report.passed) {
      try { await writeFile(join(report.browser_provider.fixture_root, 'stop-fixture'), '1', { flag: 'wx' }); }
      catch (error) { cleanupError(error, '本轮合成提供者自退标记'); }
    }
    if (host) {
      try { await host.finish(); } catch (error) { cleanupError(error, '本例宿主收尾'); }
    }
    if (observer) {
      try { await observer.finish(); } catch (error) { cleanupError(error, '本例工具、插件与探针收尾'); }
      await observer.stop();
    }
    if (providerObserver) {
      try { await providerObserver.finish(); } catch (error) { cleanupError(error, '本轮合成提供者收尾'); }
      await providerObserver.stop();
    }
    try { await finishPendingProbes(report); } catch (error) { cleanupError(error, '剩余本轮探针收尾'); }
    if (fixture) {
      try {
        report.fixture_final = {};
        for (const device of [fixture.device, fixture.nextDevice])
          report.fixture_final[device] = await fixtureState(fixture, device);
        await verifyPorts(fixture, report);
      } catch (error) { cleanupError(error, '本例资源与端口收尾'); }
    }
    if (report.cleanup_errors.length) { report.passed = false; report.status = 'failed'; }
    report.process_recovery = processSummary(report);
    report.completed_at = new Date().toISOString();
    await writeFile(join(caseDirectory, 'report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  }
  return report;
}
