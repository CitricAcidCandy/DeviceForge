import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createFactories } from './frontend.mjs';
import { jobEvents, sharedJob } from '../ordinary-deadline-http/client.mjs';
import { poll } from '../device-provider/client.mjs';

const operation = action => `android.performance.${action}`;
const target = { device_id: 'perf.smoke', package: 'com.example.app' };

async function waitSamples(factory, id, minimum, signal) {
  return poll(() => factory.samples(id, { after: 0, limit: 100 }, signal), value => value.data.readings.length >= minimum,
    `性能会话 ${id} 样本`, 10000);
}

async function checkJob(context, value, label) {
  const entry = context.report.jobs.find(record => record.job_id === value.job.id);
  assert.ok(entry, `${label} 必须记录提交 Job`); entry.history = value.job;
  assert.equal(value.job.status, 'succeeded', label);
  assert.deepEqual(value.job.result, value.data, `${label} 结果必须是直接性能结果`);
  const shared = await sharedJob(context.host.client, entry);
  assert.deepEqual({ id: shared.id, operation: shared.operation, status: shared.status, result: shared.result, error: shared.error }, value.job);
  entry.events = await jobEvents(context.host.client, { ...entry, expected_status: 'succeeded' });
  return value.data;
}

async function mcpAction(context, action, input) {
  const submitted = await context.host.client.tool(operation(action), input);
  const entry = { case_id: 'MCP-' + action, job_id: submitted.id, operation: operation(action), input,
    transport: 'mcp', expected_status: 'succeeded', submit_log_id: context.report.last_request.log_id };
  context.report.jobs.push(entry);
  const job = await poll(() => context.host.client.job(entry.job_id), value => ['succeeded', 'failed', 'cancelled'].includes(value.status), entry.case_id);
  assert.equal(job.status, 'succeeded'); return job.result;
}

export async function consume(context) {
  const factories = await createFactories(context);
  const signal = AbortSignal.timeout(45000);
  try {
    context.report.stage = '性能工厂八动作';
    const capabilities = await factories.performance.capabilities(signal);
    assert.equal(capabilities.data.fps, true); assert.equal(capabilities.data.maxSamples, 3600);
    assert.equal(capabilities.data.sampleTimeoutMs, 10000);
    const serviceCapabilities = await factories.service('capabilities', undefined, signal);
    assert.deepEqual(serviceCapabilities, { metrics: ['cpu_share_percent', 'cpu_core_percent', 'pss_kib', 'rss_kib', 'fps'], fps: true,
      sourceLabel: 'plugin.performance_demo', scope: 'main_process', maxSamples: 3600, sampleTimeoutMs: 10000 });
    const started = await factories.performance.start({ target, interval_ms: 1000, duration_secs: 30 }, signal);
    const session = await checkJob(context, started, 'start');
    assert.equal(session.state, 'running');
    context.report.performance_session_id = session.id;
    await waitSamples(factories.performance, session.id, 2, signal);
    const inspected = await factories.performance.inspect(session.id, signal);
    await checkJob(context, inspected, 'inspect'); assert.equal(inspected.data.id, session.id);
    const first = await factories.performance.samples(session.id, { after: 0, limit: 100 }, signal);
    await checkJob(context, first, 'samples');
    assert.ok(first.data.readings.length >= 2); assert.equal(first.data.readings[0].fps, 60);
    assert.equal(first.data.readings[0].cpu_share_percent, null);
    assert.equal(first.data.readings[0].cpu_core_percent, null);
    const initial = first.data.readings[0], second = first.data.readings[1];
    const expectedShare = (Math.floor(second.captured_at / 10) - Math.floor(initial.captured_at / 10)) * 100
      / (second.captured_at - initial.captured_at);
    assert.ok(Math.abs(second.cpu_share_percent - expectedShare) < 0.000001);
    assert.ok(Math.abs(second.cpu_core_percent - expectedShare * 2) < 0.000001);
    assert.equal(initial.pid, 123); assert.equal(initial.pss_kib, 2048); assert.equal(initial.rss_kib, 4096);
    assert.deepEqual(initial.frame_window, { frames: 60, duration_ms: 1000, source: 'synthetic_demo' });
    const paused = await factories.performance.pause(session.id, signal); await checkJob(context, paused, 'pause');
    assert.equal(paused.data.id, session.id); assert.equal(paused.data.state, 'paused');
    const pausedJob = await factories.performance.inspect(session.id, signal); await checkJob(context, pausedJob, 'inspect-paused');
    const count = pausedJob.data.samples; await delay(1200);
    const afterPause = await factories.performance.samples(session.id, { after: count, limit: 100 }, signal);
    assert.equal(afterPause.data.readings.length, 0); assert.equal(afterPause.data.next_after, count);
    const resumed = await factories.performance.resume(session.id, signal); await checkJob(context, resumed, 'resume');
    await waitSamples(factories.performance, session.id, count + 1, signal);
    const resumedPage = await factories.performance.samples(session.id, { after: count, limit: 100 }, signal);
    await checkJob(context, resumedPage, 'samples-resumed'); assert.ok(resumedPage.data.readings.length >= 1);
    assert.equal(resumedPage.data.readings[0].cpu_share_percent, null);
    const stopped = await factories.performance.stop(session.id, signal); await checkJob(context, stopped, 'stop');
    assert.equal(stopped.data.state, 'stopped');
    const listed = await factories.performance.list({ afterId: null, limit: 100 }, signal); await checkJob(context, listed, 'list');
    assert.ok(listed.data.sessions.some(item => item.id === session.id));
    context.report.checks.push({ name: '实际 TypeScript 性能工厂与 host.performance 服务覆盖 capabilities/start/inspect/samples/pause/resume/stop/list', passed: true });
    context.report.performance_samples = { first: first.data.readings.length, resumed: resumedPage.data.readings.length,
      paused_count: count, final_state: stopped.data.state, cpu_share_expected: expectedShare };
    context.report.stage = '公开性能服务八动作';
    const serviceSession = await factories.service('start', { target: { ...target, package: 'com.example.service' }, interval_ms: 1000, duration_secs: 30 }, signal);
    assert.equal(serviceSession.state, 'running');
    const serviceId = { session_id: serviceSession.id };
    assert.equal((await factories.service('inspect', serviceId, signal)).id, serviceSession.id);
    const servicePage = await factories.service('samples', { ...serviceId, after: 0, limit: 100 }, signal);
    assert.equal(servicePage.session.id, serviceSession.id);
    assert.equal((await factories.service('pause', serviceId, signal)).state, 'paused');
    assert.equal((await factories.service('resume', serviceId, signal)).state, 'running');
    assert.equal((await factories.service('stop', serviceId, signal)).state, 'stopped');
    assert.ok((await factories.service('list', { after_id: null, limit: 100 }, signal)).sessions.some(item => item.id === serviceSession.id));
    context.report.checks.push({ name: 'runtime.performance 装配和公开 host.performance v1 严格八动作真实消费', passed: true });
    context.report.stage = 'MCP八动作提交';
    assert.equal((await mcpAction(context, 'capabilities', {})).fps, true);
    const mcpSession = await mcpAction(context, 'start', { target: { ...target, package: 'com.example.mcp' }, interval_ms: 1000, duration_secs: 30 });
    const mcpId = { session_id: mcpSession.id };
    assert.equal((await mcpAction(context, 'inspect', mcpId)).id, mcpSession.id);
    assert.equal((await mcpAction(context, 'samples', { ...mcpId, after: 0, limit: 100 })).session.id, mcpSession.id);
    assert.equal((await mcpAction(context, 'pause', mcpId)).state, 'paused');
    assert.equal((await mcpAction(context, 'resume', mcpId)).state, 'running');
    assert.equal((await mcpAction(context, 'stop', mcpId)).state, 'stopped');
    assert.ok((await mcpAction(context, 'list', { after_id: null, limit: 100 })).sessions.some(item => item.id === mcpSession.id));
    context.report.checks.push({ name: 'MCP 实际提交全部八动作并共用 HTTP Job 存储', passed: true });
    context.report.stage = '卸载换代与历史恢复';
    const oldGeneration = session.source?.generation;
    const active = await factories.performance.start({ target: { ...target, package: 'com.example.unload' }, interval_ms: 1000, duration_secs: 30 }, signal);
    const activeId = active.data.id;
    await waitSamples(factories.performance, activeId, 1, signal);
    const unloaded = await context.host.client.tool('deviceforge.unload_plugin', { id: 'performance_demo' });
    assert.equal(unloaded.state, 'unloaded'); assert.equal(unloaded.cleanup_failed, false);
    const beforeFailed = context.report.jobs.length;
    await assert.rejects(() => factories.performance.capabilities(signal), error => error.job?.status === 'failed');
    assert.equal(context.report.jobs.length, beforeFailed + 1); context.report.jobs.at(-1).expected_status = 'failed';
    factories.performance.invalidateSource();
    const beforeBlocked = context.report.requests.length;
    await assert.rejects(async () => factories.performance.capabilities(signal), error => error.code === 'unavailable_performance_observation');
    assert.equal(context.report.requests.length, beforeBlocked);
    const historical = await factories.performance.inspect(session.id, signal);
    assert.deepEqual(historical.data, stopped.data);
    const interrupted = await factories.performance.inspect(activeId, signal);
    assert.equal(interrupted.data.state, 'interrupted'); assert.deepEqual(interrupted.data.source, active.data.source);
    const reloaded = await context.host.client.post('/api/v2/plugins/performance_demo/load');
    assert.equal(reloaded.state, 'loaded'); assert.notEqual(reloaded.generation, oldGeneration);
    context.report.generations.second = reloaded.generation;
    factories.performance.refreshSourceObservation();
    assert.equal((await factories.performance.capabilities(signal)).data.fps, true);
    const restored = factories.createHistory();
    try {
      const starts = context.report.jobs.filter(entry => entry.operation === operation('start')).length;
      const restoredList = await restored.list({ afterId: null, limit: 100 }, signal);
      assert.ok(restoredList.data.sessions.some(item => item.id === session.id));
      const restoredSession = await restored.inspect(session.id, signal);
      assert.deepEqual(restoredSession.data, stopped.data);
      const restoredPage = await restored.samples(session.id, { after: 0, limit: 100 }, signal);
      assert.deepEqual(restoredPage.data.readings.slice(0, first.data.readings.length), first.data.readings);
      assert.equal(context.report.jobs.filter(entry => entry.operation === operation('start')).length, starts);
      assert.deepEqual((await restored.inspect(activeId, signal)).data, interrupted.data);
      context.report.checks.push({ name: '性能插件卸载后历史可读、重载新代且旧会话恢复不重启', passed: true });
    } finally { restored.dispose(); }
    context.report.stage = '关闭后旧引用撤销';
    await factories.dispose();
    const beforeClosed = context.report.requests.length;
    await assert.rejects(() => factories.service('capabilities', undefined, signal));
    await assert.rejects(async () => factories.runtime.performance.capabilities(signal), error => error.code === 'unavailable_performance_observation');
    assert.equal(context.report.requests.length, beforeClosed);
    context.report.checks.push({ name: '运行实例关闭后旧性能服务与消费者拒绝且零新请求', passed: true });
  } finally { await factories.dispose(); }
}

export async function verifyJobs({ host, report }) {
  assert.ok(report.jobs.length >= 8);
  for (const entry of report.jobs) {
    const job = await sharedJob(host.client, entry); assert.equal(job.status, entry.expected_status);
    assert.equal(job.operation, entry.operation); assert.deepEqual(job.input, entry.input);
    entry.history = job; entry.events = await jobEvents(host.client, entry);
  }
  report.job_count = report.jobs.length;
}
