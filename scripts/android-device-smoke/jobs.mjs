import assert from 'node:assert/strict';
import { poll } from '../device-provider/client.mjs';
import { jobEvents, sharedJob } from '../ordinary-deadline-http/client.mjs';
import { finishedTool, keys, observations } from './fixtures.mjs';

export const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/;
export async function jobList(host) {
  const jobs = await host.client.json('/api/v2/jobs?limit=100');
  assert.ok(jobs.length < 100, '本次完整任务列表不可截断');
  return jobs;
}
export async function submit(host, report, caseId, operation, input, transport = 'http') {
  report.active_case_id = caseId;
  const observed = host.client.scope({ case_id: caseId, phase: 'submit' });
  const submitted =
    transport === 'http'
      ? await observed.post('/api/v2/jobs', { operation, input }, { status: 202 })
      : await observed.tool(operation, input);
  assert.match(submitted.id, uuid);
  const entry = {
    case_id: caseId,
    operation,
    input,
    transport,
    job_id: submitted.id,
    submit_log_id: report.last_request.log_id,
    expected_status: 'succeeded',
  };
  assert.match(entry.submit_log_id, uuid);
  report.jobs.push(entry);
  return entry;
}
export async function record(host, entry, status = entry.expected_status) {
  entry.expected_status = status;
  await poll(
    () => host.client.job(entry.job_id),
    (job) => ['succeeded', 'failed', 'cancelled'].includes(job.status),
    entry.case_id,
    15000,
  );
  const job = await sharedJob(host.client, entry);
  assert.equal(job.status, status);
  entry.history = job;
  entry.events = await jobEvents(host.client, entry);
  return job;
}
export async function oneJob(
  host,
  fixture,
  report,
  { caseId, operation, input, transport, argv, expected },
) {
  const beforeJobs = await jobList(host),
    before = await keys(fixture);
  const entry = await submit(host, report, caseId, operation, input, transport);
  const job = await record(host, entry);
  const ids = new Set(beforeJobs.map((item) => item.id));
  assert.deepEqual(
    (await jobList(host)).filter((item) => !ids.has(item.id)).map((item) => item.id),
    [entry.job_id],
  );
  const added = (await observations(fixture)).filter((item) => !before.includes(item.directory));
  assert.equal(added.length, 1, 'AD-TOOL-COUNT:' + caseId);
  assert.deepEqual(added[0].ready.argv, argv, 'AD-TOOL-ARGV:' + caseId);
  entry.tool = await finishedTool(added[0]);
  assert.deepEqual(job.result, expected, 'AD-JOB-RESULT:' + caseId);
  assert.equal(job.error, null, 'AD-JOB-ERROR:' + caseId);
  return entry;
}
export async function preserveHistory(host, report, phase) {
  for (const entry of report.jobs) {
    assert.deepEqual(await sharedJob(host.client, entry), entry.history, phase + ' 保留任务原文');
    assert.deepEqual(await jobEvents(host.client, entry), entry.events, phase + ' 保留事件');
  }
  report.history_phases ??= [];
  report.history_phases.push({ phase, jobs: report.jobs.length });
}

export async function verifyInventory(host, fixture, report) {
  const expected = {
    jobs: 60,
    tools: 57,
    java: 14,
    adb: 43,
    statuses: { succeeded: 51, failed: 4, cancelled: 5 },
    configuration_failures_without_tools: 3,
  };
  report.expected_inventory = expected;
  const actualJobs = await jobList(host),
    actualTools = await observations(fixture);
  const jobIds = report.jobs.map((entry) => entry.job_id),
    toolDirectories = report.jobs
      .filter((entry) => entry.tool)
      .map((entry) => entry.tool.directory);
  assert.equal(new Set(jobIds).size, expected.jobs, 'AD-INVENTORY-UNIQUE-JOBS');
  assert.equal(report.jobs.length, expected.jobs, 'AD-INVENTORY-JOBS');
  assert.deepEqual(
    actualJobs.map((job) => job.id).sort(),
    [...jobIds].sort(),
    'AD-INVENTORY-HOST-JOBS',
  );
  assert.equal(new Set(toolDirectories).size, expected.tools, 'AD-INVENTORY-UNIQUE-TOOLS');
  assert.equal(toolDirectories.length, expected.tools, 'AD-INVENTORY-TOOLS');
  assert.deepEqual(
    actualTools.map((item) => item.directory).sort(),
    [...toolDirectories].sort(),
    'AD-INVENTORY-OBSERVED-TOOLS',
  );
  const statuses = Object.fromEntries(
    Object.keys(expected.statuses).map((status) => [
      status,
      actualJobs.filter((job) => job.status === status).length,
    ]),
  );
  assert.deepEqual(statuses, expected.statuses, 'AD-INVENTORY-STATUSES');
  for (const entry of report.jobs) {
    const job = actualJobs.find((candidate) => candidate.id === entry.job_id);
    assert.equal(job.status, entry.expected_status, 'AD-INVENTORY-JOB-STATUS');
    assert.equal(entry.history.status, entry.expected_status);
  }
  const withoutTools = report.jobs.filter((entry) => !entry.tool);
  assert.deepEqual(
    withoutTools.map((entry) => entry.case_id).sort(),
    ['host-empty-artifacts-missing-adb', 'APKS-缺JAR-http', 'APKS-缺Java-alias-mcp'].sort(),
    'AD-INVENTORY-CONFIGURATION-FAILURES',
  );
  assert.ok(
    withoutTools.every(
      (entry) => entry.expected_status === 'failed' && entry.history.result === null,
    ),
  );
  const java = actualTools.filter((item) => item.ready.tool_kind === 'java').length,
    adb = actualTools.length - java;
  assert.equal(java, expected.java, 'AD-INVENTORY-JAVA');
  assert.equal(adb, expected.adb, 'AD-INVENTORY-ADB');
  report.inventory = {
    jobs: actualJobs.length,
    tools: actualTools.length,
    java,
    adb,
    statuses,
    configuration_failures_without_tools: withoutTools.length,
    unique_jobs_and_tools: true,
  };
  report.checks.push({
    name: '完整60个唯一Job/57个唯一工具、14次Java/43次ADB及精确终态分布',
    passed: true,
  });
}

export async function verifyPerformanceInventory(host, fixture, report) {
  const jobs = await jobList(host),
    tools = await observations(fixture);
  const additional = report.jobs.filter((entry) => entry.inventory_group === 'performance');
  const builtin = additional.filter((entry) => entry.plugin_call_required === false),
    plugins = additional.filter((entry) => entry.plugin_call_required !== false);
  assert.equal(additional.length, 39, 'AD-PERF-INVENTORY-JOBS');
  assert.equal(builtin.length, 28);
  assert.equal(plugins.length, 11);
  assert.equal(report.performance.direct_jobs.length, 4);
  assert.equal(report.performance.sessions.length, 4);
  const statuses = Object.fromEntries(
    ['succeeded', 'failed', 'cancelled'].map((status) => [
      status,
      additional.filter((entry) => entry.history.status === status).length,
    ]),
  );
  assert.deepEqual(statuses, { succeeded: 35, failed: 4, cancelled: 0 });
  const pluginTools = plugins.flatMap((entry) => entry.tools ?? [entry.tool]);
  assert.equal(pluginTools.length, 35);
  assert.ok(pluginTools.every(Boolean));
  assert.ok(builtin.every((entry) => !entry.tool && !entry.tools));
  const background = report.performance.sample_groups.flatMap((group) => group.tools);
  const previous = report.jobs
    .filter((entry) => entry.inventory_group !== 'performance')
    .map((entry) => entry.tool)
    .filter(Boolean);
  const all = [...previous, ...pluginTools, ...background].map((item) => item.directory);
  assert.equal(new Set(all).size, all.length, 'AD-PERF-INVENTORY-UNIQUE-TOOLS');
  assert.deepEqual(
    tools.map((item) => item.directory).sort(),
    all.sort(),
    'AD-PERF-INVENTORY-ALL-OBSERVATIONS',
  );
  assert.equal(jobs.length, 99);
  assert.equal(new Set(report.jobs.map((entry) => entry.job_id)).size, 99);
  assert.deepEqual(
    jobs.map((job) => job.id).sort(),
    report.jobs.map((entry) => entry.job_id).sort(),
  );
  const overall = Object.fromEntries(
    ['succeeded', 'failed', 'cancelled'].map((status) => [
      status,
      jobs.filter((job) => job.status === status).length,
    ]),
  );
  assert.deepEqual(overall, { succeeded: 86, failed: 8, cancelled: 5 });
  report.performance.inventory = {
    jobs: 39,
    builtin_jobs: 28,
    plugin_jobs: 11,
    direct_and_discovery_tools: 35,
    statuses,
    background_sample_groups: report.performance.sample_groups.length,
    background_tools: background.length,
    complete_background_groups: report.performance.sample_groups.filter((group) => group.complete)
      .length,
    partial_background_groups: report.performance.sample_groups.filter((group) => !group.complete)
      .length,
    background_jobs: 0,
    unique_tools_and_associations: true,
  };
  report.expected_inventory = {
    jobs: 99,
    statuses: { succeeded: 86, failed: 8, cancelled: 5 },
    apks: report.apks_inventory,
    performance_jobs: 39,
    performance_plugin_tools: 35,
    background_tools_rule: '按实际同父PID样本分组逐项核对，不套用APKS单Job单工具计数',
  };
  report.inventory = {
    jobs: jobs.length,
    tools: tools.length,
    java: tools.filter((item) => item.ready.tool_kind === 'java').length,
    adb: tools.filter((item) => item.ready.tool_kind !== 'java').length,
    statuses: overall,
    apks: report.apks_inventory,
    performance: report.performance.inventory,
  };
  report.checks.push({
    name: 'PERF独立39个Job/35个直接工具、28内置会话Job及后台零嵌套Job分组；整体99个唯一Job',
    passed: true,
  });
}
