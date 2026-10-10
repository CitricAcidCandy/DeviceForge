import assert from 'node:assert/strict';
import { sharedJob } from './client.mjs';
import { processVisible, ready, release } from './control.mjs';
import { submit, terminal, cancel, verifyHistory } from './jobs.mjs';
import { verifyProcess } from './process-evidence.mjs';
import { elapsedMs, monotonicNs, waitFor } from './wait.mjs';
import { passed, recordFailure, stage } from './evidence.mjs';

async function settle(branches, report) {
  // 一个分支失败后仍等本轮其他观察结束，不把未消费 Promise 留给宿主收尾。
  const outcomes = await Promise.allSettled(branches.map((run) => (async () => {
    try { return await run(); }
    catch (error) { recordFailure(report, error); throw error; }
  })()));
  const failed = outcomes.find((outcome) => outcome.status === 'rejected');
  if (failed) throw failed.reason;
  return outcomes.map((outcome) => outcome.value);
}

async function submitReady(host, item, kind, suffix, transport, expected, report) {
  const caseId = `p${item.protocolVersion}_${suffix}`;
  const entry = await submit(host, item, kind, caseId, transport, expected, report);
  await ready(item, entry, kind === 'short' ? 8000 : 12000);
  return entry;
}

async function holdLong(host, item, entry, report) {
  const held = () => elapsedMs(entry.driver_ready_observed_ns, monotonicNs());
  // 使用驱动真实单调时钟，每个进程各自从已观察到 ready 起算。
  await waitFor(held, (elapsed) => elapsed >= 60500, `${entry.case_id} 越过 60 秒`, 65000, 250);
  const job = await sharedJob(host.client, entry);
  assert.equal(job.status, 'running', '超过旧 60 秒后同次 Job 仍须 Running');
  assert.equal(job.result, null);
  assert.ok(processVisible(entry.process.pid), '超过旧 60 秒后仍须是本次实际夹具 PID');
  host.assertRunning();
  entry.over_sixty_seconds = { driver_elapsed_ms: held(), status: job.status,
    fixture_pid: entry.process.pid, fixture_visible: true, host_pid: host.child.pid,
    sampled_at: new Date().toISOString(), host_start_count: report.host_start_count };
  assert.ok(entry.over_sixty_seconds.driver_elapsed_ms > 60000);
  await waitFor(held, (elapsed) => elapsed >= 61000, `${entry.case_id} 实际保持 61 秒`, 2000, 50);
  await release(item, entry);
  await terminal(host, item, entry);
  await verifyProcess(item, entry);
  passed(report, `L${item.protocolVersion}`, { job_id: entry.job_id, case_id: entry.case_id,
    driver_hold_ms: entry.driver_hold_ms, fixture_elapsed_ms: entry.result.elapsed_ms });
}

export async function verifyMatrix(host, items, report) {
  await stage(report, 'L2/L3 并行真实 ready→61 秒→release', async () => {
    const entries = await settle(items.map((item) => () => submitReady(host, item, 'long', 'long',
      item.protocolVersion === 2 ? 'http' : 'mcp', 'succeeded', report)), report);
    await settle(items.map((item, index) => () => holdLong(host, item, entries[index], report)), report);
  });
  for (const item of items) {
    await stage(report, `S${item.protocolVersion}-D 短预算真实到期`, async () => {
      const entry = await submitReady(host, item, 'short', 'deadline',
        item.protocolVersion === 2 ? 'http' : 'mcp', 'failed', report);
      host.assertRunning();
      assert.equal((await sharedJob(host.client, entry)).status, 'running');
      // 不写 release，宿主同一短截止点终止 hold；等待额度不修改生产预算。
      await terminal(host, item, entry);
      await verifyProcess(item, entry);
      passed(report, `S${item.protocolVersion}-D`, { job_id: entry.job_id,
        error: entry.terminal.error, control_reason: entry.control_cancel_reason });
    });
    await stage(report, `S${item.protocolVersion}-C ready 后主动取消`, async () => {
      const entry = await submitReady(host, item, 'short', 'cancel',
        item.protocolVersion === 2 ? 'mcp' : 'http', 'cancelled', report);
      assert.ok(processVisible(entry.process.pid));
      await cancel(host, item, entry, item.protocolVersion === 2 ? 'http' : 'mcp');
      await terminal(host, item, entry);
      await verifyProcess(item, entry);
      passed(report, `S${item.protocolVersion}-C`, { job_id: entry.job_id,
        control_reason: entry.control_cancel_reason, cancel_transport: entry.cancel.transport });
    });
    await stage(report, `M${item.protocolVersion} 默认预算有限响应`, async () => {
      const entry = await submitReady(host, item, 'default', 'default',
        item.protocolVersion === 2 ? 'http' : 'mcp', 'succeeded', report);
      await terminal(host, item, entry);
      await verifyProcess(item, entry);
      passed(report, `M${item.protocolVersion}`, { job_id: entry.job_id, budget_source: 'default' });
    });
  }
  await stage(report, '8 Job 历史/唯一终态/一次真实调用', async () => {
    await verifyHistory(host, report);
    assert.equal(new Set(report.jobs.map((entry) => entry.process.request_id)).size, 8);
    report.process_identity = { jobs: 8, unique_request_ids: 8,
      distinct_direct_pids: new Set(report.jobs.map((entry) => entry.process.pid)).size,
      pairs: report.jobs.map((entry) => ({ job_id: entry.job_id, plugin_id: entry.plugin_id,
        case_id: entry.case_id, request_id: entry.process.request_id, pid: entry.process.pid })) };
    passed(report, '8 Job 同 HTTP/MCP 历史与唯一终态');
  });
}
