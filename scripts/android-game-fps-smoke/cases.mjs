import assert from 'node:assert/strict';
import { poll } from '../device-provider/client.mjs';
import { operation } from '../android-device-observation-smoke/cases.mjs';
import { assertReading, deviceId, packageName, setMode } from './fixtures.mjs';
function remember(report, session, caseId) {
  assert.equal(session.source.plugin_id, 'android-device');
  assert.equal(session.source.device.local_id, deviceId);
  report.sessions.push({
    id: session.id,
    case_id: caseId,
    source: structuredClone(session.source),
  });
  return session;
}
const input = (interval) => ({
  target: { device_id: deviceId, package: packageName },
  interval_ms: interval,
  duration_secs: 120,
});
export async function business(host, fixture, observer, frontend, loaded, report) {
  await host.client.post('/api/v2/device-providers/android-device/refresh', {
    generation: loaded.generation,
  });
  const caps = await operation(host, report, 'capabilities');
  assert.equal(caps.fps, true);
  assert.equal(caps.scope, 'main_process');
  assert.deepEqual(await operation(host, report, 'capabilities', {}, 'mcp'), caps);
  assert.equal((await frontend.capabilities(AbortSignal.timeout(10000))).data.fps, true);
  report.capabilities = caps;
  report.checks.push({ name: 'FPS来源声明HTTP/MCP一致及实际前端消费', passed: true });
  const history = [];
  for (const scenario of fixture.cases.filter((value) => value.kind === 'sample')) {
    await setMode(fixture, scenario.id);
    const started = await frontend.start(
      input(scenario.expected.length > 1 ? 1000 : 60000),
      AbortSignal.timeout(10000),
    );
    const session = remember(report, started.data, scenario.id);
    await frontend.select(session.id, AbortSignal.timeout(10000));
    const count = scenario.expected.length;
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
        for (const [index, reading] of page.readings.entries())
          assertReading(reading, scenario.expected[Math.min(index, count - 1)]);
        return page;
      },
      (page) => page.readings.length >= count,
      '冻结FPS场景原值',
      20000,
    );
    const stop = await frontend.stop(session.id, AbortSignal.timeout(10000));
    assert.equal(stop.data.state, 'stopped');
    const page = await operation(host, report, 'samples', {
      session_id: session.id,
      after: 0,
      limit: 100,
    });
    for (const [index, reading] of page.readings.entries())
      assertReading(reading, scenario.expected[Math.min(index, count - 1)]);
    const consumed = await frontend.samples(
      session.id,
      { after: 0, limit: 100 },
      AbortSignal.timeout(10000),
    );
    assert.deepEqual(consumed.data, page);
    assert.deepEqual(frontend.snapshot().readings, page.readings);
    history.push(page);
    report.checks.push({ name: scenario.title, passed: true });
  }
  for (const scenario of fixture.cases.filter((value) => value.kind === 'failure')) {
    await setMode(fixture, scenario.id);
    const session = remember(
      report,
      await operation(host, report, 'start', input(60000)),
      scenario.id,
    );
    const ended = await poll(
      async () => {
        observer.assertHealthy();
        return operation(host, report, 'inspect', { session_id: session.id }, 'mcp');
      },
      (value) => ['failed', 'interrupted'].includes(value.state),
      '进程身份换代终态',
      20000,
    );
    assert.equal(ended.state, 'failed', 'FPS-PROCESS-CHANGE-FAILED');
    assert.ok(typeof ended.error === 'string' && ended.error.length > 0);
    const page = await operation(host, report, 'samples', {
      session_id: session.id,
      after: 0,
      limit: 100,
    });
    assert.equal(page.readings.length, 0, 'FPS-PROCESS-CHANGE-NO-PARTIAL-SAMPLE');
    history.push(page);
    report.checks.push({ name: scenario.title, passed: true });
  }
  const lifecycle = fixture.cases.find((value) => value.kind === 'lifecycle');
  assert.ok(lifecycle, 'FPS-LIFECYCLE-CASE-REQUIRED');
  await setMode(fixture, lifecycle.id);
  const session = remember(
    report,
    await operation(host, report, 'start', input(60000), 'mcp'),
    lifecycle.id,
  );
  await poll(
    async () =>
      operation(host, report, 'samples', { session_id: session.id, after: 0, limit: 100 }),
    (page) => page.readings.length >= 1,
    '暂停前样本',
    15000,
  );
  assert.equal((await frontend.pause(session.id, AbortSignal.timeout(10000))).data.state, 'paused');
  const paused = await operation(host, report, 'samples', {
    session_id: session.id,
    after: 0,
    limit: 100,
  });
  observer.holdNext(lifecycle.hold_category);
  assert.equal(
    (await frontend.resume(session.id, AbortSignal.timeout(10000))).data.state,
    'running',
  );
  const held = await poll(
    () => {
      observer.assertHealthy();
      return report.tools.find((value) => value.held);
    },
    Boolean,
    '恢复采样SF工具原OS门闩',
    15000,
  );
  assert.equal(
    (await host.client.tool('deviceforge.unload_plugin', { id: 'android-device' })).state,
    'unloaded',
  );
  frontend.invalidateSource();
  const ended = await operation(host, report, 'inspect', { session_id: session.id }, 'mcp');
  assert.equal(ended.state, 'interrupted');
  assert.ok(!(await host.client.tools()).includes('plugin.android-device.performance.sample'));
  const interrupted = await operation(host, report, 'samples', {
    session_id: session.id,
    after: 0,
    limit: 100,
  });
  assert.deepEqual(interrupted.readings, paused.readings, 'FPS-UNLOAD-NO-PARTIAL-READING');
  for (const reading of paused.readings) assertReading(reading, lifecycle.expected[0]);
  report.lifecycle = {
    interrupted: ended,
    held_tool: held.name,
    old_generation: loaded.generation,
  };
  const reloaded = await host.client.post('/api/v2/plugins/android-device/load');
  assert.notEqual(reloaded.generation, loaded.generation);
  await host.client.post('/api/v2/device-providers/android-device/refresh', {
    generation: reloaded.generation,
  });
  frontend.refreshSourceObservation();
  report.lifecycle.new_generation = reloaded.generation;
  const current = remember(
    report,
    await operation(host, report, 'start', input(60000), 'mcp'),
    lifecycle.id + '-reloaded',
  );
  assert.equal(current.source.generation, reloaded.generation);
  await poll(
    async () =>
      operation(host, report, 'samples', { session_id: current.id, after: 0, limit: 100 }),
    (page) => page.readings.length >= 1,
    '新代有效FPS',
    15000,
  );
  assert.equal(
    (await operation(host, report, 'stop', { session_id: current.id }, 'mcp')).state,
    'stopped',
  );
  const currentPage = await operation(host, report, 'samples', {
    session_id: current.id,
    after: 0,
    limit: 100,
  });
  for (const reading of currentPage.readings) assertReading(reading, lifecycle.expected[0]);
  history.push(currentPage);
  assert.equal((await host.client.post('/api/v2/plugins/android-device/unload')).state, 'unloaded');
  for (const previous of history) {
    const page = await operation(
      host,
      report,
      'samples',
      { session_id: previous.session.id, after: 0, limit: 100 },
      'mcp',
    );
    assert.deepEqual(page, previous);
    report.history.push(page);
  }
  report.checks.push({
    name: '暂停/继续触发真实采样、在途SF卸载Interrupted与历史/代次保持',
    passed: true,
  });
}
