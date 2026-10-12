import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hash, object, poll, value, type Host, type JsonObject } from './six-business-support.ts';
import type { Source } from './ordinary-business-source.ts';
import type { Reporter } from './ordinary-business-report.ts';

export async function settingsBackupCases(host: Host, remote: Source, audit: Reporter, storage: string) {
  const records: JsonObject[] = []; audit.report.settings_backup_cases = records;
  const localValue = { label: '合成本地原配置' };
  const remoteValue = { label: '合成远端新配置' };
  const run = async (name: string, input: unknown, viaMcp = false, expected = 'succeeded') => {
    const operation = `plugin.settings.${name}`; const job = await host.run(operation, input, viaMcp);
    await audit.recordJob(host, job, expected, operation); assert.equal(job.status, expected); return job;
  };
  const begin = (owner: string, viaMcp: boolean) => {
    const evidence: JsonObject = { owner_id: owner, transport: viaMcp ? 'mcp' : 'http', write_local_backup: false };
    records.push(evidence); return evidence;
  };
  const sourceSnapshot = (evidence: JsonObject, start: number) => {
    const calls = remote.calls.slice(start).map((call) => ({ ...call }));
    evidence.source_call_start = start; evidence.source_calls = calls;
    evidence.post_delta = calls.filter((call) => call.kind === 'remote.save' && call.method === 'POST').length;
  };
  const onePost = (evidence: JsonObject) => {
    assert.equal(evidence.post_delta, 1, '关闭本地备份的远端保存只发送一次 POST');
    const calls = evidence.source_calls as JsonObject[]; assert.equal(calls.length, 1);
    assert.equal(calls[0].sentinel_header, true);
    assert.equal(calls[0].input_sha256, hash(JSON.stringify(remoteValue)));
  };
  const seed = async (owner: string, viaMcp: boolean, evidence: JsonObject) => {
    const input = { scope: 'workspace', owner_id: owner, section: 'deviceInfo' };
    const written = value(await run('set', { ...input, expected_revision: '0', value: localValue }, viaMcp));
    assert.equal(written.revision, '1');
    const path = join(storage, 'workspaces', owner, 'settings.json'); const before = await readFile(path);
    evidence.local_before = { bytes: before.length, sha256: hash(before), revision: written.revision };
    await audit.flush(); return { input, path, before };
  };
  const unchanged = async (saved: Awaited<ReturnType<typeof seed>>, evidence: JsonObject, viaMcp: boolean) => {
    const after = await readFile(saved.path);
    const current = value(await run('get', saved.input, viaMcp));
    evidence.local_after = { bytes: after.length, sha256: hash(after), revision: current.revision,
      value_sha256: hash(JSON.stringify(current.value)) };
    evidence.local_bytes_unchanged = after.equals(saved.before);
    await audit.flush(); assert.deepEqual(after, saved.before);
    assert.equal(current.revision, '1'); assert.deepEqual(current.value, localValue);
  };
  const savedWithoutBackup = (job: JsonObject, evidence: JsonObject) => {
    const result = value(job);
    evidence.remote_result = { source: result.source, remote_committed: result.remote_committed,
      backup_updated: result.backup_updated, revision: result.revision, value_sha256: hash(JSON.stringify(result.value)) };
    assert.equal(result.source, 'remote'); assert.equal(result.remote_committed, true);
    assert.equal(result.backup_updated, false); assert.equal(result.revision, null);
    assert.deepEqual(result.value, remoteValue);
  };

  for (const viaMcp of [false, true]) {
    const transport = viaMcp ? 'MCP' : 'HTTP';
    await audit.check(`settings：${transport} 关闭本地备份仍提交远端且本地字节修订不变`, async () => {
      const evidence = begin(viaMcp ? 'backup_false_mcp' : 'backup_false_http', viaMcp);
      const saved = await seed(String(evidence.owner_id), viaMcp, evidence);
      remote.settings('ok'); const start = remote.calls.length;
      const job = await run('remote.save', { ...saved.input, expected_revision: '1', value: remoteValue,
        write_local_backup: false }, viaMcp);
      evidence.job_id = job.id; sourceSnapshot(evidence, start); await audit.flush();
      savedWithoutBackup(job, evidence); onePost(evidence); await unchanged(saved, evidence, !viaMcp);
    });
  }
  await audit.check('settings：关闭本地备份仍预检 CAS，过期修订零 POST', async () => {
    const evidence = begin('backup_false_stale', true); const saved = await seed(String(evidence.owner_id), false, evidence);
    remote.settings('ok'); const start = remote.calls.length;
    const job = await run('remote.save', { ...saved.input, expected_revision: '0', value: remoteValue,
      write_local_backup: false }, true, 'failed');
    evidence.job_id = job.id; sourceSnapshot(evidence, start); await audit.flush();
    assert.equal(evidence.post_delta, 0); assert.deepEqual(evidence.source_calls, []);
    await unchanged(saved, evidence, false);
  });

  await audit.check('settings：关闭本地备份持锁期间本地写入排队，释放后同修订成功', async () => {
    const evidence = begin('backup_false_lock', false); const saved = await seed(String(evidence.owner_id), false, evidence);
    remote.settings('hold'); const start = remote.calls.length;
    let held = false; let released = false;
    try {
      const pending = object(await host.submit('plugin.settings.remote.save', { ...saved.input, expected_revision: '1',
        value: remoteValue, write_local_backup: false }));
      evidence.job_id = pending.id; await audit.flush(); await remote.waitSettings(); held = true;
      sourceSnapshot(evidence, start); evidence.request_held = true;
      const pendingStatus = await host.shared(String(pending.id)); evidence.held_job_status = pendingStatus.status;
      assert.equal(pendingStatus.status, 'running'); onePost(evidence);
      const competing = object(await host.submit('plugin.settings.set', { ...saved.input, expected_revision: '1',
        value: { label: '合成本地后写配置' } }, true));
      evidence.local_job_id = competing.id; evidence.local_expected_revision = '1'; await audit.flush();
      await poll(async () => object((await host.request(`/api/v2/jobs/${String(competing.id)}`)).json),
        (job) => job.status === 'running', '关闭备份时本地写入进入锁等待');
      const running = await host.shared(String(competing.id));
      const locked = await readFile(saved.path);
      evidence.locked_local = { bytes: locked.length, sha256: hash(locked),
        revision: object(JSON.parse(locked.toString('utf8'))).revision };
      evidence.locked_local_bytes_unchanged = locked.equals(saved.before); evidence.local_waiting_status = running.status;
      await audit.flush(); assert.equal(running.status, 'running'); assert.deepEqual(locked, saved.before);
      remote.releaseSettings(); released = true; evidence.response_released = true;
      const remoteJob = await host.finished(String(pending.id));
      await audit.recordJob(host, remoteJob, 'succeeded', 'plugin.settings.remote.save');
      savedWithoutBackup(remoteJob, evidence);
      const localJob = await host.finished(String(competing.id));
      await audit.recordJob(host, localJob, 'succeeded', 'plugin.settings.set');
      evidence.local_result_revision = value(localJob).revision; assert.equal(evidence.local_result_revision, '2');
      await remote.settingsClosed(); evidence.connection_released = true;
      const after = await readFile(saved.path); const current = value(await run('get', saved.input));
      evidence.local_after = { bytes: after.length, sha256: hash(after), revision: current.revision,
        value_sha256: hash(JSON.stringify(current.value)) };
      sourceSnapshot(evidence, start); await audit.flush(); onePost(evidence);
      assert.equal(current.revision, '2'); assert.deepEqual(current.value, { label: '合成本地后写配置' });
    } finally {
      if (held && !released) { remote.releaseSettings(); evidence.response_released_on_failure = true; }
      remote.settings('ok');
    }
  });

  await audit.check('settings：关闭本地备份在途取消仅一次 POST且本地字节不变', async () => {
    const evidence = begin('backup_false_cancel', false); const saved = await seed(String(evidence.owner_id), true, evidence);
    remote.settings('hold'); const start = remote.calls.length;
    let held = false; let closed = false;
    try {
      const pending = object(await host.submit('plugin.settings.remote.save', { ...saved.input, expected_revision: '1',
        value: remoteValue, write_local_backup: false }));
      evidence.job_id = pending.id; await audit.flush(); await remote.waitSettings(); held = true;
      evidence.request_held_at = new Date().toISOString(); sourceSnapshot(evidence, start);
      const running = await host.shared(String(pending.id)); evidence.held_job_status = running.status;
      const locked = await readFile(saved.path);
      evidence.held_local_sha256 = hash(locked); await audit.flush();
      assert.equal(running.status, 'running'); assert.deepEqual(locked, saved.before); onePost(evidence);
      evidence.cancel_transport = 'mcp'; evidence.cancel_requested_at = new Date().toISOString();
      await host.cancel(String(pending.id), true); evidence.cancel_acknowledged = true;
      const job = await host.finished(String(pending.id));
      evidence.terminal_status = job.status; evidence.terminal_observed_at = new Date().toISOString();
      await audit.recordJob(host, job, 'cancelled', 'plugin.settings.remote.save'); assert.equal(job.status, 'cancelled');
      await remote.settingsClosed(); closed = true;
      evidence.connection_released = true; evidence.connection_closed_observed_at = new Date().toISOString();
      await unchanged(saved, evidence, false);
      const released = value(await run('set', { ...saved.input, expected_revision: '1', value: localValue }, true));
      evidence.lock_release_revision = released.revision; assert.equal(released.revision, '2');
      sourceSnapshot(evidence, start); await audit.flush(); onePost(evidence);
    } finally {
      if (held && !closed) { remote.releaseSettings(); evidence.response_released_on_failure = true; }
      remote.settings('ok');
    }
  });
}
