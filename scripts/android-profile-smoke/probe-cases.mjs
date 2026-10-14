import assert from 'node:assert/strict';
import { poll } from '../device-provider/client.mjs';
import { deviceId, probeContract } from './probe-route.mjs';
import { packageName } from './protocol.mjs';
import { setMode } from './fixtures.mjs';

const operation = 'plugin.android-device.stack.probe';
async function submit(host, report, scenario, transport) {
  const input = { device_id: deviceId, input: { package: packageName } };
  const submitted =
    transport === 'mcp'
      ? await host.client.tool(operation, input)
      : await host.client.post('/api/v2/jobs', { operation, input }, { status: 202 });
  const id = submitted.id ?? submitted.job_id;
  assert.match(id, /^[a-f\d-]{36}$/);
  const entry = {
    case_id: scenario.id,
    job_id: id,
    operation,
    transport,
    submit_log_id: report.last_request.log_id,
    expected_status: 'succeeded',
    plugin_call_required: true,
  };
  report.jobs.push(entry);
  return entry;
}
export async function probeBusiness(host, fixture, observer, loaded, report) {
  await host.client.post('/api/v2/device-providers/android-device/refresh', {
    generation: loaded.generation,
  });
  assert.ok((await host.client.tools()).includes(operation), 'PROFILE-PROBE-MCP-DYNAMIC');
  for (const [index, scenario] of fixture.cases.entries()) {
    await setMode(fixture, scenario.id);
    const baseline = report.tools.length;
    const entry = await submit(host, report, scenario, index % 2 ? 'mcp' : 'http');
    const job = await poll(
      async () => {
        observer.assertHealthy();
        return host.client.job(entry.job_id);
      },
      (value) => ['succeeded', 'failed', 'cancelled'].includes(value.status),
      'Root资格公开共享Job',
      15000,
    );
    assert.equal(job.status, 'succeeded', 'PROFILE-PROBE-JOB-SUCCEEDED');
    assert.equal(job.error, null);
    assert.equal(job.operation, operation, 'PROFILE-PROBE-PUBLIC-OPERATION');
    const history = await host.client.tool('deviceforge.get_job', { id: job.id });
    assert.deepEqual(history, job, 'PROFILE-PROBE-HTTP-MCP-HISTORY');
    assert.deepEqual(
      job.result,
      {
        result: {
          format_version: 1,
          device_id: deviceId,
          package: packageName,
          clock: 'boottime',
          ...scenario.expected,
        },
        artifacts: [],
      },
      'PROFILE-PROBE-EXACT-RESULT',
    );
    const tools = report.tools.slice(baseline);
    assert.deepEqual(
      tools.map((value) => value.argv),
      scenario.commands.map((value) => value.argv),
      'PROFILE-PROBE-EXACT-COMMAND-ORDER',
    );
    assert.ok(
      tools.every((value) => value.mode === scenario.id),
      'PROFILE-PROBE-MODE',
    );
    Object.assign(entry, {
      history: job,
      tools: tools.map((value) => value.name),
      source_generation: loaded.generation,
    });
    report.history.push(job);
    report.checks.push({
      name: scenario.id + '公开资格/实际拒绝/固定命令与同Job历史',
      passed: true,
    });
  }
  assert.equal(
    (await host.client.tool('deviceforge.unload_plugin', { id: 'android-device' })).state,
    'unloaded',
  );
  assert.ok(!(await host.client.tools()).includes(operation), 'PROFILE-PROBE-UNLOADED-MCP');
  const reloaded = await host.client.post('/api/v2/plugins/android-device/load');
  assert.notEqual(reloaded.generation, loaded.generation, 'PROFILE-PROBE-NEW-GENERATION');
  assert.ok((await host.client.tools()).includes(operation), 'PROFILE-PROBE-RELOADED-MCP');
  for (const previous of report.history) {
    assert.deepEqual(
      await host.client.job(previous.id),
      previous,
      'PROFILE-PROBE-STABLE-HTTP-HISTORY',
    );
    assert.deepEqual(
      await host.client.tool('deviceforge.get_job', { id: previous.id }),
      previous,
      'PROFILE-PROBE-STABLE-MCP-HISTORY',
    );
  }
  assert.equal((await host.client.post('/api/v2/plugins/android-device/unload')).state, 'unloaded');
  report.lifecycle = { old_generation: loaded.generation, new_generation: reloaded.generation };
  report.checks.push({ name: '资格贡献动态卸载/重载、固定代次与历史保持', passed: true });
}
export { probeContract };
