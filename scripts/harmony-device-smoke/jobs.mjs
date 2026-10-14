import assert from 'node:assert/strict';
import { poll } from '../device-provider/client.mjs';
import { jobEvents, sharedJob } from '../ordinary-deadline-http/client.mjs';
import { finishedTool, keys, observations } from './fixtures.mjs';

export const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/;
export async function jobList(host) {
  const jobs = await host.client.json('/api/v2/jobs?limit=200');
  assert.ok(jobs.length < 200, '本次完整任务列表不可截断');
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
  assert.equal(added.length, 1, 'HD-TOOL-COUNT:' + caseId);
  assert.deepEqual(added[0].ready.argv, argv, 'HD-TOOL-ARGV:' + caseId);
  entry.tool = await finishedTool(added[0]);
  assert.deepEqual(job.result, expected, 'HD-JOB-RESULT:' + caseId);
  assert.equal(job.error, null, 'HD-JOB-ERROR:' + caseId);
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
