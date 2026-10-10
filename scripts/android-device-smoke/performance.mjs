import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { action, envelope, submitAction } from './actions.mjs';
import { catalog } from './bootstrap.mjs';
import { discover } from './discovery.mjs';
import { operation, pluginId } from './deployment.mjs';
import { finishedTool, keys, observations, otherId, offlineId, release, setMode, started } from './fixtures.mjs';
import { jobList, oneJob, record, submit } from './jobs.mjs';
import { owner, plugins } from './lifecycle.mjs';
import { finishSample, rawSample, sampleArgv, sampleCapability, sampleGroups } from './performance-fixtures.mjs';
import { performanceSessions } from './performance-lifecycle.mjs';

export async function sessionJob(host, report, name, input, transport = 'http', expected = 'succeeded') {
  const entry = await submit(host, report, 'PERF-会话-' + name + '-' + transport + '-' + report.performance.builtin_jobs.length,
    'android.performance.' + name, input, transport);
  entry.inventory_group = 'performance'; entry.plugin_call_required = false;
  const job = await record(host, entry, expected); report.performance.builtin_jobs.push(entry.job_id);
  return { entry, value: job.result };
}

async function missingSource(host, fixture, report) {
  const before = await keys(fixture);
  for (const [name, input, transport] of [
    ['start', { target: { device_id: otherId, package: 'org.smoke.performance.missing' }, interval_ms: 1000, duration_secs: 120 }, 'http'],
    ['capabilities', {}, 'mcp'],
  ]) {
    const { entry } = await sessionJob(host, report, name, input, transport, 'failed');
    assert.equal(entry.history.error, '资源不存在：性能采样源不可用'); assert.equal(entry.history.result, null);
  }
  assert.deepEqual(await keys(fixture), before);
  report.checks.push({ name: 'PERF显式源暂未加载仍可启动，live精确not_found且零工具、无Android回退', passed: true });
}

async function admission(host, fixture, report) {
  const base = action(report.provider, sampleCapability, otherId, { package: 'org.smoke.performance.admission' });
  const before = await keys(fixture), baseline = await jobList(host);
  for (const [name, input, status, code] of [
    ['版本', { ...base, version: 2 }, 404, 'not_found'], ['离线', { ...base, device_id: offlineId }, 409, 'conflict'],
    ['旧代', { ...base, generation: '00000000-0000-4000-8000-000000000000' }, 409, 'conflict'],
    ['封套', { ...base, unknown: true }, 400, 'invalid_input'], ['包名', { ...base, input: { package: 'invalid' } }, 400, 'invalid_input'],
  ]) {
    const observed = host.client.scope({ case_id: 'PERF-准入-' + name, phase: 'reject' });
    await observed.post('/api/v2/device-actions', input, { status, code });
    await observed.tool('deviceforge.invoke_device', input, code);
  }
  await host.client.post('/api/v2/jobs', { operation: 'android.performance.sample', input: { device_id: otherId, package: 'org.smoke.app' } }, { status: 404, code: 'not_found' });
  await host.client.tool('android.performance.sample', { device_id: otherId, package: 'org.smoke.app' }, 'not_found');
  assert.deepEqual(await keys(fixture), before); assert.deepEqual(await jobList(host), baseline);
  report.checks.push({ name: 'PERF版本/离线/旧代/未知封套/包名及不存在sample别名精确拒绝，零Job/工具', passed: true });
}

async function direct(host, fixture, report, entryPoint, transport) {
  const packageName = 'org.smoke.performance.' + entryPoint + '_' + transport;
  const before = await keys(fixture), cases = 'PERF-直接-' + entryPoint + '-' + transport;
  const entry = entryPoint === 'capability'
    ? await submitAction(host, report, cases, action(report.provider, sampleCapability, otherId, { package: packageName }), transport)
    : await submit(host, report, cases, operation(sampleCapability), envelope(otherId, { package: packageName }), transport);
  entry.inventory_group = 'performance'; const job = await record(host, entry);
  const groups = sampleGroups((await observations(fixture)).filter(item => !before.includes(item.directory)));
  assert.equal(groups.length, 1); const group = await finishSample(groups[0], { packageName });
  entry.tools = group.tools; rawSample(job.result.result, group); assert.deepEqual(job.result.artifacts, []);
  assert.deepEqual(Object.keys(job.result).sort(), ['artifacts','result']);
  report.performance.direct_jobs.push(entry.job_id);
  report.checks.push({ name: cases + ' 一Job/五笔固定工具、同父PID、精确原始数值及零输出产物', passed: true });
}

async function lockBoundaries(host, fixture, report) {
  const packageName = 'org.smoke.performance.read_parallel', before = await keys(fixture);
  await setMode(fixture, 'hold');
  const held = await submit(host, report, 'PERF-read先持有', operation(sampleCapability), envelope(otherId, { package: packageName }), 'http');
  held.inventory_group = 'performance';
  const firstTool = await started(fixture, before, sampleArgv(packageName)[0]); await setMode(fixture, 'normal');
  const parallel = await oneJob(host, fixture, report, { caseId: 'PERF-read与同设备write并行', operation: operation('app.stop'),
    input: envelope(otherId, { package: 'org.smoke.performance.parallel' }), transport: 'mcp',
    argv: ['-s', otherId, 'shell', 'am', 'force-stop', 'org.smoke.performance.parallel'], expected: { result: { output: '' }, artifacts: [] } });
  parallel.inventory_group = 'performance';
  assert.deepEqual(await keys(fixture), [...before, firstTool.directory, parallel.tool.directory].sort());
  await release(firstTool); await record(host, held);
  const firstGroup = sampleGroups((await observations(fixture)).filter(item => item.ready.sample_package === packageName));
  assert.equal(firstGroup.length,1); const complete = await finishSample(firstGroup[0], { packageName }); held.tools = complete.tools;
  rawSample(held.history.result.result,complete); assert.deepEqual(held.history.result.artifacts,[]);
  assert.ok(BigInt(parallel.tool.completed.unix_ns) < BigInt(complete.tools[0].completed.unix_ns));

  const prior = await keys(fixture); await setMode(fixture,'hold');
  const barrier = await submitAction(host, report, 'PERF-provider写屏障', action(report.provider,'disconnect',null,{address:'127.0.0.1:5555'}),'http');
  barrier.inventory_group = 'performance'; const blocking = await started(fixture,prior,['disconnect','127.0.0.1:5555']);
  await setMode(fixture,'normal');
  const queuedPackage = 'org.smoke.performance.provider_wait';
  const queued = await submitAction(host,report,'PERF-read等待provider写',action(report.provider,sampleCapability,otherId,{package:queuedPackage}),'mcp');
  queued.inventory_group = 'performance'; await delay(100);
  assert.deepEqual(await keys(fixture),[...prior,blocking.directory].sort(),'AD-PERF-PROVIDER-BARRIER');
  await release(blocking); await record(host,barrier); await record(host,queued); barrier.tool = await finishedTool(blocking);
  const groups = sampleGroups((await observations(fixture)).filter(item => item.ready.sample_package === queuedPackage));
  assert.equal(groups.length,1); const group = await finishSample(groups[0],{packageName:queuedPackage}); queued.tools = group.tools;
  rawSample(queued.history.result.result,group); assert.deepEqual(queued.history.result.artifacts,[]);
  assert.ok(BigInt(group.tools[0].ready.unix_ns) >= BigInt(barrier.tool.completed.unix_ns));
  report.checks.push({ name: 'PERF-device/read与同设备write真实并行，provider/write真实阻塞read', passed:true });
}

export async function performanceBusiness(host, deployment, fixture, report) {
  report.performance = { direct_jobs: [], builtin_jobs: [], sessions: [], sample_groups: [],
    boundary: '后台采样不创建Job；原APKS库存、直接采样库存与后台采样分组分别核对' };
  await missingSource(host,fixture,report);
  const loaded = owner(await host.client.post('/api/v2/plugins/' + pluginId + '/load'),deployment,undefined,'loaded');
  await plugins(host,loaded); await catalog(host,deployment,report,'PERF独立加载',true,loaded);
  const baseline = await jobList(host), tools = await keys(fixture);
  const unobserved = action(report.provider,sampleCapability,otherId,{package:'org.smoke.performance.unobserved'});
  await host.client.post('/api/v2/device-actions',unobserved,{status:409,code:'conflict'});
  await host.client.tool('deviceforge.invoke_device',unobserved,'conflict');
  assert.deepEqual(await jobList(host),baseline); assert.deepEqual(await keys(fixture),tools);
  const discovery = await discover(host,deployment,fixture,report,{phase:'PERF首次代'}); discovery.inventory_group = 'performance';
  await admission(host,fixture,report);
  for (const entryPoint of ['capability','direct']) for (const transport of ['http','mcp']) await direct(host,fixture,report,entryPoint,transport);
  await lockBoundaries(host,fixture,report); await performanceSessions(host,deployment,fixture,report);
}
