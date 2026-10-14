import assert from 'node:assert/strict';
import { poll } from '../device-provider/client.mjs';
import { assertObservation, assertReading, deviceId, packageName, setMode } from './fixtures.mjs';

export async function operation(host, report, name, input = {}, transport = 'http') {
  const full = 'android.performance.' + name;
  const submitted =
    transport === 'http'
      ? await host.client.post('/api/v2/jobs', { operation: full, input }, { status: 202 })
      : await host.client.tool(full, input);
  const submitLogId = report.last_request.log_id;
  const job = await poll(
    () => host.client.job(submitted.id),
    (value) => ['succeeded', 'failed', 'cancelled'].includes(value.status),
    full,
  );
  report.jobs.push({
    job_id: job.id,
    operation: full,
    submit_log_id: submitLogId,
    expected_status: job.status,
    plugin_call_required: false,
  });
  assert.equal(job.status, 'succeeded', job.error ?? full);
  assert.deepEqual(await host.client.tool('deviceforge.get_job', { id: job.id }), job);
  return job.result;
}
function remember(report, value) {
  assert.equal(value.source.plugin_id, 'android-device');
  assert.equal(value.source.device.local_id, deviceId);
  report.sessions.push({
    id: value.id,
    source: structuredClone(value.source),
    request: structuredClone(value.request),
  });
  return value;
}
async function waitReadings(host, report, session, count, legacy = false) {
  return poll(
    async () => {
      const page = await operation(
        host,
        report,
        'samples',
        { session_id: session.id, after: 0, limit: 100 },
        'mcp',
      );
      for (const reading of page.readings) assertReading(reading, legacy);
      return page;
    },
    (page) => page.readings.length >= count,
    '真实持久化观测样本',
    15000,
  );
}
async function stoppedPage(host, report, session, transport = 'http') {
  const stop = await operation(host, report, 'stop', { session_id: session.id }, transport);
  assert.equal(stop.state, 'stopped');
  const page = await operation(
    host,
    report,
    'samples',
    { session_id: session.id, after: 0, limit: 100 },
    transport,
  );
  assert.deepEqual(page.session, stop);
  return page;
}
function startInput(suffix, interval = 1000) {
  return {
    target: { device_id: deviceId, package: packageName + '_' + suffix },
    interval_ms: interval,
    duration_secs: 120,
  };
}
export async function business(host, fixture, observer, frontend, loaded, report) {
  await host.client.post('/api/v2/device-providers/android-device/refresh', {
    generation: loaded.generation,
  });
  const http = await operation(host, report, 'capabilities');
  const mcp = await operation(host, report, 'capabilities', {}, 'mcp');
  assert.deepEqual(mcp, http);
  assert.equal(http.scope, 'main_process');
  assert.equal(http.device_observation, true);
  assert.ok(http.metrics.includes('device_observation'));
  assert.ok(http.metrics.includes('battery_net_power_mw'));
  const frontendCapabilities = await frontend.capabilities(AbortSignal.timeout(10000));
  assert.equal(frontendCapabilities.data.scope, 'main_process');
  assert.ok(frontendCapabilities.data.metrics.includes('device_observation'));
  report.capabilities = { http, mcp, frontend: frontendCapabilities.data };
  report.checks.push({
    name: 'HTTP/MCP新cap声明与实际前端能力消费，基础scope=main_process',
    passed: true,
  });

  const response = await frontend.start(startInput('frontend'), AbortSignal.timeout(10000));
  const normal = remember(report, response.data);
  await frontend.select(normal.id, AbortSignal.timeout(10000));
  await waitReadings(host, report, normal, 2);
  const normalPage = await stoppedPage(host, report, normal, 'mcp');
  for (const reading of normalPage.readings) assertReading(reading);
  const actualPage = await frontend.samples(
    normal.id,
    { after: 0, limit: 100 },
    AbortSignal.timeout(10000),
  );
  assert.deepEqual(actualPage.data, normalPage);
  assert.deepEqual(frontend.snapshot().readings, normalPage.readings);
  assert.equal(normalPage.readings[0].cpu_share_percent, null);
  assertObservation(normalPage.readings[0].device_observation, normalPage.readings[0].captured_at);
  report.checks.push({
    name: '实际前端冻结副本/HTTP/MCP同原值历史，负放电-2000mW与嵌套device作用域',
    passed: true,
  });

  await setMode(fixture, 'legacy');
  const legacy = remember(
    report,
    await operation(host, report, 'start', startInput('legacy'), 'mcp'),
  );
  await waitReadings(host, report, legacy, 1, true);
  const legacyPage = await stoppedPage(host, report, legacy);
  for (const reading of legacyPage.readings) assertReading(reading, true);
  await frontend.select(legacy.id, AbortSignal.timeout(10000));
  const frontendLegacy = await frontend.samples(
    legacy.id,
    { after: 0, limit: 100 },
    AbortSignal.timeout(10000),
  );
  assert.deepEqual(frontendLegacy.data, legacyPage);
  report.checks.push({
    name: '旧缺省样本历史和实际前端兼容，不把冻结电池/缺测温度补成0',
    passed: true,
  });

  await setMode(fixture, 'normal');
  observer.holdNext('thermal');
  const inFlight = remember(
    report,
    await operation(host, report, 'start', startInput('unload', 60000)),
  );
  const held = await poll(
    () => {
      observer.assertHealthy();
      return report.tools.find((entry) => entry.held);
    },
    Boolean,
    '温度工具原句柄已门闩',
  );
  const unloaded = await host.client.tool('deviceforge.unload_plugin', { id: 'android-device' });
  assert.equal(unloaded.state, 'unloaded');
  frontend.invalidateSource();
  const ended = await operation(host, report, 'inspect', { session_id: inFlight.id }, 'mcp');
  assert.equal(ended.state, 'interrupted');
  assert.ok(!(await host.client.tools()).includes('plugin.android-device.performance.sample'));
  const reloaded = await host.client.post('/api/v2/plugins/android-device/load');
  assert.equal(reloaded.state, 'loaded');
  assert.notEqual(reloaded.generation, loaded.generation);
  await host.client.post('/api/v2/device-providers/android-device/refresh', {
    generation: reloaded.generation,
  });
  frontend.refreshSourceObservation();
  const current = remember(
    report,
    await operation(host, report, 'start', startInput('new_generation'), 'mcp'),
  );
  assert.equal(current.source.generation, reloaded.generation);
  await waitReadings(host, report, current, 1);
  const currentPage = await stoppedPage(host, report, current, 'mcp');
  for (const reading of currentPage.readings) assertReading(reading);
  assert.equal((await host.client.post('/api/v2/plugins/android-device/unload')).state, 'unloaded');
  for (const previous of [normalPage, legacyPage, currentPage]) {
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
  const finalList = await operation(host, report, 'list', { after_id: null, limit: 100 });
  assert.equal(finalList.sessions.length, 4);
  for (const session of report.sessions)
    assert.deepEqual(
      finalList.sessions.find((value) => value.id === session.id).source,
      session.source,
    );
  report.lifecycle = {
    held_tool: held.name,
    old_generation: loaded.generation,
    new_generation: reloaded.generation,
    interrupted: ended,
    final_list: finalList,
  };
  report.checks.push({
    name: '真实在途温度取消与卸载Interrupted、新代重载和原值/功率/旧缺省历史不改写',
    passed: true,
  });
}
