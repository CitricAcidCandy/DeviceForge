import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { applicationCase, argvFor, detailArgv, outputFor, submitApplication } from './applications.mjs';
import { finishedTool, keys, observations, otherId, release, setMode, started } from './fixtures.mjs';
import { record } from './jobs.mjs';

export async function applicationSharedLocks(host, fixture, report) {
  const before = await keys(fixture); await setMode(fixture, 'hold');
  const first = await submitApplication(host, report, { caseId: '应用写锁首启动', name: 'app.start', point: 'capability', transport: 'http' });
  const held = await started(fixture, before, argvFor('app.start'));
  await setMode(fixture, 'normal');
  const stop = await submitApplication(host, report, { caseId: '同设备停止alias等待', name: 'app.stop', point: 'alias', transport: 'mcp' });
  const reset = await submitApplication(host, report, { caseId: '同设备重置direct等待', name: 'app.reset', point: 'direct', transport: 'http' });
  const parallel = await submitApplication(host, report, { caseId: '不同设备停止并行', name: 'app.stop', point: 'capability', transport: 'mcp', deviceId: otherId });
  await record(host, parallel);
  const during = (await observations(fixture)).filter(item => !before.includes(item.directory));
  assert.equal(during.length, 2, 'HD-APP-LOCK-BLOCKED');
  const parallelTool = during.find(item => item.directory !== held.directory); assert.ok(parallelTool);
  assert.deepEqual(parallelTool.ready.argv, argvFor('app.stop', otherId)); parallel.tool = await finishedTool(parallelTool);
  assert.equal((await host.client.job(first.job_id)).status, 'running'); await delay(100);
  assert.deepEqual(await keys(fixture), [...before, held.directory, parallelTool.directory].sort(), 'HD-APP-LOCK-NO-QUEUED-START');
  await release(held); for (const entry of [first, stop, reset]) await record(host, entry);
  first.tool = await finishedTool(held);
  const queued = (await observations(fixture)).filter(item => !before.includes(item.directory) && !during.some(prior => prior.directory === item.directory));
  assert.equal(queued.length, 2); const ordered = [];
  for (const [entry, name] of [[stop, 'app.stop'], [reset, 'app.reset']]) {
    const item = queued.find(candidate => JSON.stringify(candidate.ready.argv) === JSON.stringify(argvFor(name))); assert.ok(item);
    entry.tool = await finishedTool(item); ordered.push(entry.tool);
    assert.ok(BigInt(entry.tool.ready.unix_ns) >= BigInt(first.tool.completed.unix_ns), 'HD-APP-LOCK-FIRST-COMPLETED');
    assert.deepEqual(entry.history.result, entry === stop ? { output: outputFor(name) } : { result: { output: outputFor(name) }, artifacts: [] });
  }
  assert.deepEqual(first.history.result, { result: { output: outputFor('app.start') }, artifacts: [] });
  assert.deepEqual(parallel.history.result, { result: { output: outputFor('app.stop') }, artifacts: [] });
  assert.ok(BigInt(parallel.tool.ready.unix_ns) < BigInt(first.tool.completed.unix_ns), 'HD-APP-LOCK-PARALLEL');
  assert.ok(BigInt(ordered[0].completed.unix_ns) <= BigInt(ordered[1].ready.unix_ns)
    || BigInt(ordered[1].completed.unix_ns) <= BigInt(ordered[0].ready.unix_ns), 'HD-APP-LOCK-QUEUED-SERIAL');
  report.application_lock_jobs = [first, stop, reset, parallel].map(item => item.job_id);
  report.checks.push({ name: '启动/停止/重置跨入口共享同设备写锁、另设备并行，真实工具门闩与顺序', passed: true, jobs: report.application_lock_jobs });
}

export async function applicationCancellation(host, fixture, report) {
  const cases = [
    { name: 'app.start', point: 'capability', transport: 'http' },
    { name: 'app.stop', point: 'alias', transport: 'mcp' },
    { name: 'app.reset', point: 'direct', transport: 'http' },
    { name: 'app.start', point: 'alias', transport: 'mcp', automatic: true },
  ];
  const jobs = [];
  for (const request of cases) {
    const before = await keys(fixture); await setMode(fixture, 'hold');
    const entry = await submitApplication(host, report, { ...request, caseId: '应用取消-' + request.name + (request.automatic ? '-自动详情' : '') });
    const tool = await started(fixture, before, request.automatic ? detailArgv() : argvFor(request.name));
    await host.client.scope({ case_id: entry.case_id, phase: 'cancel' }).post('/api/v2/jobs/' + entry.job_id + '/cancel');
    await record(host, entry, 'cancelled'); assert.equal(entry.history.result, null);
    entry.tool = await finishedTool(tool, { cancelled: true }); await assert.rejects(lstat(join(tool.directory, 'release')), { code: 'ENOENT' });
    assert.deepEqual(await keys(fixture), [...before, tool.directory].sort(), 'HD-APP-CANCEL-NO-NEXT-TOOL');
    jobs.push(entry.job_id); await setMode(fixture, 'normal');
  }
  report.application_cancel_jobs = jobs;
  report.checks.push({ name: '三应用动作及自动详情在途取消，唯一终态、直接PID退出及不启动后续HDC', passed: true, jobs });
}

export async function reloadedApplication(host, fixture, report) {
  const entry = await applicationCase(host, fixture, report, { caseId: '新代自动启动-alias-mcp', name: 'app.start', point: 'alias', transport: 'mcp', automatic: true });
  report.reloaded_application_job = entry.job_id;
  report.checks.push({ name: '新代重新发现后自动启动仍可调用，旧代引用单独拒绝', passed: true, job_id: entry.job_id });
}

export async function applicationFailureResults(host, fixture, report) {
  const cases = [
    { name: 'app.start', point: 'capability', transport: 'http', automatic: true, mode: 'duplicate-detail', error: '依赖执行失败：工具依赖失败：应用详情JSON无效或超出限额' },
    { name: 'app.start', point: 'direct', transport: 'mcp', mode: 'ambiguous-success', error: '依赖执行失败：工具依赖失败：HDC未返回明确成功结果' },
    { name: 'app.reset', point: 'alias', transport: 'http', mode: 'stderr-diagnostic', error: '依赖执行失败：工具依赖失败：HDC返回失败诊断' },
  ];
  const jobs = [];
  for (const request of cases) {
    const before = await keys(fixture); await setMode(fixture, request.mode);
    const entry = await submitApplication(host, report, { ...request, caseId: '应用失败-' + request.mode });
    const job = await record(host, entry, 'failed'); assert.equal(job.result, null); assert.equal(job.error, request.error);
    const added = (await observations(fixture)).filter(item => !before.includes(item.directory));
    assert.equal(added.length, 1, 'HD-APP-FAILURE-ONE-TOOL');
    assert.deepEqual(added[0].ready.argv, request.automatic ? detailArgv() : argvFor(request.name));
    entry.tool = await finishedTool(added[0]); jobs.push(entry.job_id); await setMode(fixture, 'normal');
  }
  report.application_failure_jobs = jobs;
  report.checks.push({ name: '自动详情重复键不启第二HDC、非独立成功行拒绝与stderr失败优先，固定精确错误', passed: true, jobs });
}
