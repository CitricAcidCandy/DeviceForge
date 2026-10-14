import assert from 'node:assert/strict';
import { sharedJob, jobEvents } from './client.mjs';
import { uuid, validateIdentity } from './control.mjs';
import { elapsedMs, monotonicNs, waitFor } from './wait.mjs';

const terminalStatuses = new Set(['succeeded', 'failed', 'cancelled']);

export async function submit(host, item, kind, caseId, transport, expectedStatus, report) {
  const entry = {
    case_id: caseId,
    plugin_id: item.pluginId,
    protocol_version: item.protocolVersion,
    operation: item.operations[kind],
    input: { case_id: caseId },
    kind,
    submit_transport: transport,
    expected_status: expectedStatus,
    submitted_at: new Date().toISOString(),
    driver_submit_started_ns: monotonicNs(),
  };
  // 先登记场景，提交或等待失败时仍保留本次调用定位。
  report.jobs.push(entry);
  const client = host.client.scope({ case_id: caseId, phase: 'submit' });
  const job =
    transport === 'http'
      ? await client.post(
          '/api/v2/jobs',
          { operation: entry.operation, input: entry.input },
          { status: 202 },
        )
      : await client.tool(entry.operation, entry.input);
  assert.match(job.id, uuid);
  assert.equal(job.operation, entry.operation);
  assert.deepEqual(job.input, entry.input);
  entry.job_id = job.id;
  entry.initial_status = job.status;
  entry.driver_submit_returned_ns = monotonicNs();
  const request = report.requests.findLast(
    (request) => request.case_id === caseId && request.phase === 'submit',
  );
  assert.match(request.log_id, uuid);
  request.job_id = job.id;
  entry.submit_log_id = request.log_id;
  return entry;
}

export async function terminal(host, item, entry, timeoutMs = 15000) {
  const client = host.client.scope({
    case_id: entry.case_id,
    job_id: entry.job_id,
    phase: 'terminal',
  });
  await waitFor(
    () => client.job(entry.job_id),
    (job) => terminalStatuses.has(job.status),
    `${entry.case_id} 共享任务终态`,
    timeoutMs,
    100,
  );
  const job = await sharedJob(host.client, entry);
  assert.equal(job.status, entry.expected_status);
  entry.terminal = {
    id: job.id,
    operation: job.operation,
    input: job.input,
    status: job.status,
    created_at: job.created_at,
    error: job.error,
  };
  if (entry.expected_status === 'succeeded') {
    assert.equal(job.error, null);
    // 协议 2/3 的真实宿主发布适配返回该领域包装，不按业务 JSON 外形猜格式。
    assert.deepEqual(Object.keys(job.result).sort(), ['artifacts', 'result']);
    assert.deepEqual(job.result.artifacts, []);
    const result = job.result.result;
    assert.deepEqual(
      Object.keys(result).sort(),
      [
        'case_id',
        'completed_monotonic_ns',
        'elapsed_ms',
        'pid',
        'plugin_id',
        'protocol_version',
        'ready_monotonic_ns',
        'request_id',
        'request_operation',
        'run_id',
      ].sort(),
    );
    validateIdentity(item, entry, result);
    assert.equal(result.ready_monotonic_ns, entry.process.ready_monotonic_ns);
    const measured = elapsedMs(result.ready_monotonic_ns, result.completed_monotonic_ns);
    assert.ok(Number.isFinite(result.elapsed_ms) && result.elapsed_ms >= 0);
    assert.ok(Math.abs(measured - result.elapsed_ms) <= 1, '夹具结果必须来自本次单调时钟');
    if (entry.kind === 'long') {
      assert.ok(measured >= 61000, '夹具本侧实际执行必须超过旧 60 秒');
      assert.ok(entry.driver_hold_ms >= 61000, '驱动本侧从实际 ready 至 release 至少保持 61 秒');
    }
    entry.result = result;
    entry.host_result_format = 'published_artifacts';
  } else {
    assert.equal(job.result, null, '取消或到期不得提交成功结果');
    assert.equal(job.error, entry.expected_status === 'failed' ? '执行超时' : null);
  }
  entry.job_events = await jobEvents(host.client, entry);
  assert.ok(entry.job_events.some((event) => event.status === 'running'));
  return job;
}

export async function cancel(host, item, entry, transport) {
  const observed = await sharedJob(host.client, entry);
  assert.equal(observed.status, 'running');
  entry.driver_cancel_started_ns = monotonicNs();
  const sinceSubmit = elapsedMs(entry.driver_submit_started_ns, entry.driver_cancel_started_ns);
  assert.ok(sinceSubmit < item.shortTimeoutMs, '主动取消必须在本次短预算内发起');
  const client = host.client.scope({
    case_id: entry.case_id,
    job_id: entry.job_id,
    phase: 'cancel',
  });
  const result =
    transport === 'http'
      ? await client.post(`/api/v2/jobs/${entry.job_id}/cancel`)
      : await client.tool('deviceforge.cancel_job', { id: entry.job_id });
  assert.equal(result.id, entry.job_id);
  assert.equal(result.status, 'cancelled');
  entry.cancel = {
    transport,
    issued_before_short_budget: true,
    since_submit_ms: sinceSubmit,
    returned_status: result.status,
  };
}

export async function verifyHistory(host, report) {
  const history = await host.client.json('/api/v2/jobs?limit=100');
  assert.equal(history.length, 8, '空目录本轮只允许创建矩阵中的 8 个 Job');
  assert.equal(new Set(report.jobs.map((entry) => entry.job_id)).size, 8);
  assert.deepEqual(
    history.map((job) => job.id).sort(),
    report.jobs.map((entry) => entry.job_id).sort(),
  );
  for (const entry of report.jobs) {
    const current = await sharedJob(host.client, entry);
    assert.equal(current.status, entry.expected_status);
    const stored = history.find((job) => job.id === entry.job_id);
    assert.deepEqual(current, stored);
    assert.deepEqual(await jobEvents(host.client, entry), entry.job_events);
  }
  report.history = {
    job_ids: report.jobs.map((entry) => entry.job_id),
    jobs: 8,
    terminal_events_per_job: 1,
    http_mcp_same_jobs: true,
  };
}
