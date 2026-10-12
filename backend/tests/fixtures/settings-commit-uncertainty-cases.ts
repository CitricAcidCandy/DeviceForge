// 资源回收与远端提交分别核验；本地锁释放检查只能在在途请求结束之后执行。
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { hash, object, value, type Host, type JsonObject } from './six-business-support.ts';
import type { Reporter } from './ordinary-business-report.ts';
import type { CommitSource } from './settings-commit-uncertainty-source.ts';

export async function commitCases(host: Host, remote: CommitSource, audit: Reporter, storage: string) {
  const results = audit.report.scenarios as JsonObject[];
  const cases = [
    { id: 'response_disconnect', mode: 'disconnect', submitMcp: false, cancelMcp: false, expected: 'failed' },
    { id: 'http_cancel', mode: 'hold', submitMcp: true, cancelMcp: false, expected: 'cancelled' },
    { id: 'mcp_cancel', mode: 'hold', submitMcp: false, cancelMcp: true, expected: 'cancelled' },
  ] as const;
  const run = async (operation: string, input: unknown, viaMcp = false) => {
    const job = await host.run(operation, input, viaMcp);
    await audit.recordJob(host, job, 'succeeded', operation); assert.equal(job.status, 'succeeded'); return value(job);
  };
  for (const scenario of cases) {
    const owner = { scope: 'workspace', owner_id: scenario.id, section: 'deviceInfo' };
    const localValue = { fixture: '原本地备份', scenario: scenario.id };
    const remoteValue = { fixture: '远端已提交', scenario: scenario.id };
    const evidence: JsonObject = { id: scenario.id, expected_status: scenario.expected,
      submission: scenario.submitMcp ? 'mcp' : 'http', cancellation: scenario.mode === 'hold' ? (scenario.cancelMcp ? 'mcp' : 'http') : null,
      expected_remote_sha256: hash(JSON.stringify(remoteValue)), completed: false };
    results.push(evidence);
    let before: Buffer;
    let jobId: string;
    const directory = join(storage, 'workspaces', scenario.id);
    const path = join(directory, 'settings.json');
    await audit.check(`${scenario.id}：隔离本地备份及修订准备`, async () => {
      assert.equal((await run('plugin.settings.set', { ...owner, expected_revision: '0', value: localValue }, scenario.submitMcp)).revision, '1');
      before = await readFile(path); evidence.local_before_sha256 = hash(before);
      evidence.local_revision_before = '1'; remote.arm(scenario.id, scenario.mode, remoteValue);
    });
    await audit.check(`${scenario.id}：真实 POST 提交后门闩及共享 Job`, async () => {
      const input = { ...owner, expected_revision: '1', value: remoteValue };
      const pending = object(await host.submit('plugin.settings.remote.save', input, scenario.submitMcp));
      assert.equal(typeof pending.id, 'string'); jobId = String(pending.id);
      evidence.job_id = jobId; evidence.input_sha256 = hash(JSON.stringify(input));
      const committed = await remote.committed(scenario.id);
      assert.equal(committed.ordinal, 1); assert.equal(committed.state_sha256, evidence.expected_remote_sha256);
      evidence.commit_latch = committed;
      // 独立 GET 证明旧服务已拥有新值，不把调用方尚未收到的 POST 响应视为确认。
      assert.deepEqual(await remote.readBack(), remoteValue); evidence.remote_readback_before_cancel = true;
      if (scenario.mode === 'hold') {
        const active = await host.shared(jobId); assert.equal(active.status, 'running');
        evidence.cancellation_sequence = remote.markCancellation(scenario.id);
        await host.cancel(jobId, scenario.cancelMcp); evidence.cancel_request_accepted = true;
      }
      const job = await host.finished(jobId);
      await audit.recordJob(host, job, scenario.expected, 'plugin.settings.remote.save');
      assert.equal(job.status, scenario.expected); evidence.status = job.status;
      evidence.host_commit_confirmation = 'unknown';
    });
    await audit.check(`${scenario.id}：连接关闭、插件排空与本地原件保持`, async () => {
      await remote.closed(scenario.id);
      // 卸载成功证明公开清理契约接受排空；不依赖 Job 终态推断资源已释放。
      await host.manage('settings', 'unload', scenario.cancelMcp);
      evidence.resources = { response_connection_closed: true, plugin_unload_succeeded: true };
      assert.equal(hash(await readFile(path)), hash(before!)); evidence.local_backup_unchanged = true;
      assert.deepEqual((await readdir(directory)).sort(), ['settings.json', 'transaction.lock']);
      await host.manage('settings', 'load', !scenario.cancelMcp);
      const recovered = await run('plugin.settings.get', owner, !scenario.submitMcp);
      assert.equal(recovered.revision, '1'); assert.deepEqual(recovered.value, localValue);
      evidence.local_revision_after_operation = '1';
      // 在失败或取消请求实际结束后验证锁可用，不制造持锁请求与本地写入的依赖环。
      const probe = await run('plugin.settings.set', { ...owner, section: 'cleanupProbe', expected_revision: '1', value: null });
      assert.equal(probe.revision, '2'); evidence.local_lock_released = true;
      evidence.local_revision_after_cleanup_probe = '2';
      const terminal = await host.shared(jobId!); assert.equal(terminal.status, scenario.expected);
      evidence.terminal_preserved_after_reload = true;
    });
    await audit.check(`${scenario.id}：远端写入仍在、POST 一次且没有回滚`, async () => {
      assert.deepEqual(await remote.readBack(), remoteValue);
      const snapshot = remote.snapshot(scenario.id); assert.equal(snapshot.writes.length, 1);
      const write = snapshot.writes[0]; assert.ok(write); assert.equal(write.response_closed, true);
      assert.equal(write.ordinal, 1); assert.equal(write.state_sha256, evidence.expected_remote_sha256);
      assert.ok(write.close_sequence !== null && write.close_sequence > write.commit_sequence);
      if (scenario.mode === 'hold') {
        assert.ok(write.cancellation_sequence !== null && write.cancellation_sequence > write.commit_sequence);
        assert.ok(write.close_sequence > write.cancellation_sequence);
        assert.equal(write.disconnect_initiated_by_source, false);
      }
      evidence.remote = { state_preserved: true, rollback_observed: false, post_count: 1, automatic_retry_observed: false,
        evidence: snapshot };
      assert.deepEqual(remote.faults, []); evidence.completed = true;
    });
  }
}
