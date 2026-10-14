import assert from 'node:assert/strict';
import { sharedJob } from '../ordinary-deadline-http/client.mjs';
import { ready, release, processVisible } from '../ordinary-deadline-http/control.mjs';
import { submit, terminal, cancel } from '../ordinary-deadline-http/jobs.mjs';
import { verifyProcess } from '../ordinary-deadline-http/process-evidence.mjs';
import { elapsedMs, monotonicNs, waitFor } from '../ordinary-deadline-http/wait.mjs';
import { passed, recordFailure, stage } from '../ordinary-deadline-http/evidence.mjs';
import { verifyAddedHistory } from './history.mjs';

async function allBranches(branches, report) {
  const outcomes = await Promise.allSettled(
    branches.map((branch) =>
      (async () => {
        try {
          return await branch();
        } catch (error) {
          recordFailure(report, error);
          throw error;
        }
      })(),
    ),
  );
  const failed = outcomes.find((outcome) => outcome.status === 'rejected');
  if (failed) throw failed.reason;
  return outcomes.map((outcome) => outcome.value);
}

async function start(host, item, kind, suffix, transport, expected, report) {
  const entry = await submit(
    host,
    item,
    kind,
    `npx_p${item.protocolVersion}_${suffix}`,
    transport,
    expected,
    report,
  );
  await ready(item, entry, kind === 'short' ? 8000 : 12000);
  return entry;
}

async function longRun(host, item, entry, report) {
  const held = () => elapsedMs(entry.driver_ready_observed_ns, monotonicNs());
  await waitFor(held, (elapsed) => elapsed >= 60500, `${entry.case_id} 真实越60秒`, 65000, 250);
  const job = await sharedJob(host.client, entry);
  assert.equal(job.status, 'running');
  assert.equal(job.result, null);
  assert.ok(processVisible(entry.process.pid));
  host.assertRunning();
  entry.over_sixty_seconds = {
    driver_elapsed_ms: held(),
    status: job.status,
    fixture_pid: entry.process.pid,
    fixture_visible: true,
    npx_wrapper_pid: report.npx_wrapper.pid,
    npx_wrapper_exited: false,
    rust_pid_directly_collected: false,
    sampled_at: new Date().toISOString(),
  };
  assert.ok(entry.over_sixty_seconds.driver_elapsed_ms > 60000);
  await waitFor(held, (elapsed) => elapsed >= 61000, `${entry.case_id} 保持61秒`, 2000, 50);
  await release(item, entry);
  await terminal(host, item, entry);
  await verifyProcess(item, entry);
  passed(report, `L${item.protocolVersion}`, {
    job_id: entry.job_id,
    driver_hold_ms: entry.driver_hold_ms,
    fixture_elapsed_ms: entry.result.elapsed_ms,
    install_transport: '真实CLI',
  });
}

// 仅适配调用入口与基线；成功包装、错误、控制reason、PID和事件断言均复用冻结HTTP接口。
export async function verifyCases(host, items, baseline, report) {
  await stage(report, '真实npx L2/L3并行ready→61秒→release', async () => {
    const entries = await allBranches(
      items.map(
        (item) => () =>
          start(
            host,
            item,
            'long',
            'long',
            item.protocolVersion === 2 ? 'http' : 'mcp',
            'succeeded',
            report,
          ),
      ),
      report,
    );
    await allBranches(
      items.map((item, index) => () => longRun(host, item, entries[index], report)),
      report,
    );
  });
  for (const item of items) {
    await stage(report, `真实npx S${item.protocolVersion}-D`, async () => {
      const entry = await start(
        host,
        item,
        'short',
        'deadline',
        item.protocolVersion === 2 ? 'http' : 'mcp',
        'failed',
        report,
      );
      assert.equal((await sharedJob(host.client, entry)).status, 'running');
      await terminal(host, item, entry);
      await verifyProcess(item, entry);
      passed(report, `S${item.protocolVersion}-D`, {
        job_id: entry.job_id,
        error: entry.terminal.error,
        control_reason: entry.control_cancel_reason,
      });
    });
    await stage(report, `真实npx S${item.protocolVersion}-C`, async () => {
      const entry = await start(
        host,
        item,
        'short',
        'cancel',
        item.protocolVersion === 2 ? 'mcp' : 'http',
        'cancelled',
        report,
      );
      assert.ok(processVisible(entry.process.pid));
      await cancel(host, item, entry, item.protocolVersion === 2 ? 'http' : 'mcp');
      await terminal(host, item, entry);
      await verifyProcess(item, entry);
      passed(report, `S${item.protocolVersion}-C`, {
        job_id: entry.job_id,
        control_reason: entry.control_cancel_reason,
      });
    });
    await stage(report, `真实npx M${item.protocolVersion}默认预算`, async () => {
      const entry = await start(
        host,
        item,
        'default',
        'default',
        item.protocolVersion === 2 ? 'http' : 'mcp',
        'succeeded',
        report,
      );
      await terminal(host, item, entry);
      await verifyProcess(item, entry);
      passed(report, `M${item.protocolVersion}`, { job_id: entry.job_id, source: 'default' });
    });
  }
  await stage(report, '新增8Job与基线历史交叉核对', async () => {
    await verifyAddedHistory(host, baseline, report);
    assert.equal(new Set(report.jobs.map((entry) => entry.process.request_id)).size, 8);
    report.process_identity = {
      new_jobs: 8,
      unique_request_ids: 8,
      distinct_direct_pids: new Set(report.jobs.map((entry) => entry.process.pid)).size,
      pairs: report.jobs.map((entry) => ({
        job_id: entry.job_id,
        request_id: entry.process.request_id,
        plugin_id: entry.plugin_id,
        case_id: entry.case_id,
        pid: entry.process.pid,
      })),
    };
    passed(report, '基线保留/新增8Job/HTTP-MCP共享历史和唯一终态');
  });
}
