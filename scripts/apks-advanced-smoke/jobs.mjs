import assert from 'node:assert/strict';
import { poll } from '../device-provider/client.mjs';
import { jobEvents, sharedJob } from '../ordinary-deadline-http/client.mjs';

export async function submit(context, { caseId, operation, input, transport = 'http', expectedStatus = 'succeeded', capability = false }) {
  context.report.active_case_id = caseId;
  const observed = context.host.client.scope({ case_id: caseId, phase: 'submit' });
  const submitted = capability
    ? await observed.post('/api/v2/device-actions', input, { status: 202 })
    : transport === 'http' ? await observed.post('/api/v2/jobs', { operation, input }, { status: 202 })
      : await observed.tool(operation, input);
  const entry = { case_id: caseId, operation: submitted.operation, input: submitted.input,
    requested_operation: operation, requested_input: input, transport, job_id: submitted.id,
    expected_status: expectedStatus, submit_log_id: context.report.last_request.log_id,
    plugin_id: (submitted.operation ?? operation).startsWith('plugin.android-packages.') || (submitted.operation ?? operation).startsWith('android.package.')
      ? 'android-packages' : 'android-device' };
  assert.match(entry.job_id, /^[a-f\d-]{36}$/);
  assert.equal(submitted.operation, operation);
  if (!capability) {
    assert.deepEqual(submitted.input, input);
  } else assert.deepEqual(submitted.input, { device_id: input.device_id, input: input.input });
  context.report.jobs.push(entry);
  return entry;
}

export async function record(context, entry) {
  await poll(() => context.host.client.job(entry.job_id), value => ['succeeded', 'failed', 'cancelled'].includes(value.status), entry.case_id);
  const value = await sharedJob(context.host.client, entry);
  entry.history = value;
  assert.equal(value.status, entry.expected_status);
  entry.events = await jobEvents(context.host.client, entry);
  return value;
}

export async function history(context, phase) {
  for (const entry of context.report.jobs) {
    assert.deepEqual(await sharedJob(context.host.client, entry), entry.history);
    assert.deepEqual(await jobEvents(context.host.client, entry), entry.events);
  }
  context.report.history_phases.push({ phase, jobs: context.report.jobs.length });
}
