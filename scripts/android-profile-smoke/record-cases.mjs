import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { poll } from '../device-provider/client.mjs';
import { deviceId } from './probe-route.mjs';
import { packageName } from './protocol.mjs';
import { setMode } from './fixtures.mjs';
import { consume } from './record-results.mjs';

const operation = 'plugin.android-device.profile.record';
async function submit(host, report, scenario, transport) {
  const input = { device_id: deviceId, input: { package: packageName, duration_ms: 1000, interval_ms: 1000, capture_frames: false } };
  const submitted = transport === 'mcp' ? await host.client.tool(operation, input) : await host.client.post('/api/v2/jobs', { operation, input }, { status: 202 });
  const entry = { case_id: scenario.id, job_id: submitted.id, operation, transport, submit_log_id: report.last_request.log_id,
    expected_status: ['cancel', 'unload'].includes(scenario.kind) ? 'cancelled' : 'succeeded', plugin_call_required: true };
  report.jobs.push(entry); return entry;
}
async function waitJob(host, observer, entry) {
  const job = await poll(async () => { observer.assertHealthy(); return host.client.job(entry.job_id); },
    value => ['succeeded', 'failed', 'cancelled'].includes(value.status), 'Root录制公开共享Job', 30000);
  assert.equal(job.status, entry.expected_status, 'PROFILE-RECORD-EXPECTED-JOB');
  assert.deepEqual(await host.client.tool('deviceforge.get_job', { id: job.id }), job, 'PROFILE-RECORD-HTTP-MCP-HISTORY');
  return job;
}
export async function recordBusiness(host, fixture, observer, loaded, report, directory, frontend) {
  await host.client.post('/api/v2/device-providers/android-device/refresh', { generation: loaded.generation });
  assert.ok((await host.client.tools()).includes(operation), 'PROFILE-RECORD-DYNAMIC-LOADED');
  const downloads = join(directory, 'downloads'); await mkdir(downloads);
  for (const [index, scenario] of fixture.cases.filter(value => value.kind === 'record').entries()) {
    await setMode(fixture, scenario.id); const baseline = report.tools.length;
    const entry = await submit(host, report, scenario, index % 2 ? 'mcp' : 'http');
    const job = await waitJob(host, observer, entry); assert.equal(job.error, null);
    const tools = report.tools.slice(baseline);
    assert.ok(tools.length > 0 && tools.every(value => value.mode === scenario.id), 'PROFILE-RECORD-TOOL-MODE');
    const cleanup = tools.filter(value => value.category === 'remote-cleanup');
    assert.equal(cleanup.length, scenario.expected.stack_status === 'captured' ? 1 : 0, 'PROFILE-RECORD-CLEANUP-COUNT');
    Object.assign(entry, { history: job, tools: tools.map(value => value.name), source_generation: loaded.generation });
    await consume(host, downloads, report, scenario, job.result, frontend); report.history.push(job);
    report.checks.push({ name: scenario.id + '真实指标/官方报告晚表和原下载SHA/前端归档消费', passed: true });
  }
  if (!fixture.cases.some(value => value.kind === 'cancel')) {
    assert.equal((await host.client.post('/api/v2/plugins/android-device/unload')).state, 'unloaded');
    for (const previous of report.history) {
      assert.deepEqual(await host.client.job(previous.id), previous, 'PROFILE-FALLBACK-STABLE-HTTP-HISTORY');
      assert.deepEqual(await host.client.tool('deviceforge.get_job', { id: previous.id }), previous, 'PROFILE-FALLBACK-STABLE-MCP-HISTORY');
    }
    report.checks.push({ name: '无Root或无工具继续指标录制、空栈/无perf归档与稳定历史', passed: true }); return;
  }
  for (const scenario of fixture.cases.filter(value => ['cancel', 'unload'].includes(value.kind))) {
    await setMode(fixture, scenario.id); const baseline = report.tools.length; observer.holdNext(scenario.hold_category);
    const entry = await submit(host, report, scenario, 'mcp');
    const held = await poll(() => { observer.assertHealthy(); return report.tools.slice(baseline).find(value => value.held); }, Boolean, '原远端阶段在途ADB句柄', 20000);
    if (scenario.kind === 'cancel') await host.client.post('/api/v2/jobs/' + entry.job_id + '/cancel');
    else {
      assert.equal((await host.client.tool('deviceforge.unload_plugin', { id: 'android-device' })).state, 'unloaded');
      assert.ok(!(await host.client.tools()).includes(operation), 'PROFILE-RECORD-UNLOADED-MCP');
    }
    const job = await waitJob(host, observer, entry); assert.equal(job.result, null, 'PROFILE-CANCEL-NO-PARTIAL-ARTIFACTS');
    // 取消Job终态可先于远端cleanup收口；等待实际固定清理回执，不按端点终态猜资源完成。
    await poll(async () => {
      observer.assertHealthy(); const cleanups = report.tools.slice(baseline).filter(value => value.category === 'remote-cleanup');
      if (cleanups.length !== 1) return false;
      try { return (await readFile(join(cleanups[0].directory, 'stdout.bin'))).equals(Buffer.from('clean\n')) && await readFile(join(cleanups[0].directory, 'completed'), 'utf8') === '1'; }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    }, Boolean, '远端固定清理实际回执', 5000);
    const tools = report.tools.slice(baseline); assert.equal(tools.filter(value => value.category === 'remote-cleanup').length, 1, 'PROFILE-CANCEL-REMOTE-CLEANUP');
    Object.assign(entry, { history: job, tools: tools.map(value => value.name), held_tool: held.name, source_generation: loaded.generation });
    report.history.push(job); report.checks.push({ name: scenario.id + '在途取消/卸载、远端固定身份清理与无半产物', passed: true });
  }
  const reloaded = await host.client.post('/api/v2/plugins/android-device/load'); assert.notEqual(reloaded.generation, loaded.generation);
  assert.ok((await host.client.tools()).includes(operation), 'PROFILE-RECORD-NEW-GENERATION-MCP');
  await host.client.post('/api/v2/device-providers/android-device/refresh', { generation: reloaded.generation });
  const scenario = fixture.cases.find(value => value.kind === 'reloaded'); await setMode(fixture, scenario.id);
  const entry = await submit(host, report, scenario, 'http'), job = await waitJob(host, observer, entry); assert.equal(job.error, null);
  Object.assign(entry, { history: job, source_generation: reloaded.generation }); await consume(host, downloads, report, scenario, job.result, frontend); report.history.push(job);
  assert.equal((await host.client.post('/api/v2/plugins/android-device/unload')).state, 'unloaded');
  for (const previous of report.history) {
    assert.deepEqual(await host.client.job(previous.id), previous, 'PROFILE-RECORD-STABLE-HTTP-HISTORY');
    assert.deepEqual(await host.client.tool('deviceforge.get_job', { id: previous.id }), previous, 'PROFILE-RECORD-STABLE-MCP-HISTORY');
  }
  report.lifecycle = { old_generation: loaded.generation, new_generation: reloaded.generation };
  report.checks.push({ name: '新代Root录制产物与旧Job/原下载历史不改写', passed: true });
}
