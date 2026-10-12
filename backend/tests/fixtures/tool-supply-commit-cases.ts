// 局部 ACL 和目录监听共同证明提交分支；人工清理与插件清理失败分别报告。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, readdir, lstat, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { backend, hash, host, object, pidAlive, poll, value, type Host, type JsonObject } from './six-business-support.ts';
import { identities, type Reporter } from './ordinary-business-report.ts';
import { entries, moduleId, packages, type CommitSource } from './tool-supply-commit-source.ts';

const fixture = join(backend, 'tests/fixtures/tool-supply-commit-acl.ps1');
async function aclProcess(shell: string, args: string[]) {
  const argv = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', fixture, ...args];
  const child = spawn(shell, argv,
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stderrBytes = 0; let pending = ''; let fault: Error | undefined; let exited = false;
  const messages: JsonObject[] = [];
  child.stderr.on('data', (part: Buffer) => { stderrBytes += part.length; });
  child.on('error', () => { fault = new Error('ACL 夹具进程无法启动'); });
  child.stdin.on('error', () => { fault = new Error('ACL 夹具控制管道关闭'); });
  child.stdout.setEncoding('utf8'); child.stdout.on('data', (part: string) => {
    pending += part;
    if (pending.length > 262144) { fault = new Error('ACL 摘要超过上限'); return; }
    let index: number;
    while ((index = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, index).trim(); pending = pending.slice(index + 1);
      if (!line) continue;
      try { assert.ok(messages.length < 32); messages.push(object(JSON.parse(line))); }
      catch { fault = new Error('ACL 夹具摘要结构错误'); }
    }
  });
  const closed = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((done) => {
    child.once('close', (exitCode, signal) => { exited = true; done({ exitCode, signal }); });
  });
  async function next() {
    return poll(async () => {
      if (fault) throw fault;
      if (messages.length) return messages.shift()!;
      assert.equal(exited, false, 'ACL 夹具提前退出'); return null;
    }, (message) => message !== null, 'ACL 夹具结构化门闩', 15000).then((message) => object(message));
  }
  async function finish() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([closed, new Promise<null>((done) => { timer = setTimeout(() => done(null), 15000); timer.unref(); })]);
    if (timer) clearTimeout(timer);
    assert.ok(result, 'ACL 夹具没有自行退出；保留现场，不强杀');
    assert.equal(result.exitCode, 0); assert.equal(result.signal, null);
    const pid = child.pid!; assert.equal(pidAlive(pid), false);
    return { pid, ...result, alive: false, forced: false, stderr_bytes: stderrBytes };
  }
  return { pid: child.pid, argv, next, finish, command(text: string) { child.stdin.write(text + '\n'); },
    eof() { child.stdin.end(); } };
}

function sequenceEvidence(snapshot: JsonObject, id: string, stateRequired: boolean) {
  assert.equal(snapshot.watch_errors, 0); assert.equal(snapshot.watch_dropped, 0);
  assert.ok(Array.isArray(snapshot.events)); const events = snapshot.events.map(object);
  const backup = `.transactions/${id}/backup`; const payload = `.transactions/${id}/content/bundle`;
  const arrived = (path: string, after = 0) => events.find((event) => Number(event.sequence) > after &&
    ['created', 'renamed'].includes(String(event.kind)) && event.path === path);
  const departed = (path: string, after = 0) => events.find((event) => Number(event.sequence) >= after &&
    ((event.kind === 'deleted' && event.path === path) || (event.kind === 'renamed' && event.old_path === path)));
  const oldMoved = departed(id); assert.ok(oldMoved, '监听未证明旧 target 移出');
  const backupCreated = arrived(backup); assert.ok(backupCreated, '监听未证明本轮 backup 创建');
  assert.ok(Number(oldMoved.sequence) <= Number(backupCreated.sequence));
  const backupRestored = departed(backup, Number(backupCreated.sequence)); assert.ok(backupRestored, '监听未证明 backup 恢复移出');
  const targetRestored = arrived(id, Number(backupCreated.sequence)); assert.ok(targetRestored, '监听未证明旧 target 重现');
  assert.ok(Number(backupRestored.sequence) <= Number(targetRestored.sequence));
  if (stateRequired) {
    const stateCreated = arrived(`${payload}/.tool-supply-state.json`);
    assert.ok(stateCreated && Number(stateCreated.sequence) < Number(oldMoved.sequence), '备份前未观察到新状态创建');
    assert.equal(departed(payload), undefined, '新 payload 曾移出或被清理，不能据此证明提交失败');
  }
  return { old_target_moved: oldMoved.sequence, backup_created: backupCreated.sequence,
    backup_restored: backupRestored.sequence, old_target_reappeared: targetRestored.sequence };
}

export async function ntfsProbe(root: string, shell: string) {
  const process = await aclProcess(shell, ['-Mode', 'probe', '-Root', root]);
  process.eof(); const result = await process.next(); const exit = await process.finish();
  assert.equal(result.passed, true); assert.equal(result.acl_restored, true);
  assert.equal(result.post_release_transaction_removed, true);
  return { ...result, ...exit, fixture_argv: process.argv, independent_order: sequenceEvidence(result, 'synthetic-module', false),
    evidence: '仅独立 NTFS 路径探针；不代表插件动态验收' };
}

export async function normalShutdown(server: Host, audit: Reporter, name: string) {
  await audit.check(name, async () => {
    const shutdown = await server.close(); (audit.report.shutdowns as JsonObject[]).push(shutdown);
    assert.equal(shutdown.exitCode, 0); assert.equal(shutdown.signal, null); assert.equal(shutdown.forced, false);
    assert.equal(shutdown.shutdown_accepted, true); assert.equal(shutdown.port_released, true);
  });
}

export async function commitCases(initial: Host, source: CommitSource, audit: Reporter, root: string,
  privateBin: string, plugin: string, shell: string, trackHost: (server: Host) => void, markClosed: (server: Host) => void) {
  const installRoot = join(root, 'supply'); const target = join(installRoot, moduleId);
  const transaction = join(installRoot, '.transactions', moduleId); const payload = join(transaction, 'content', 'bundle');
  const input = { module_id: moduleId }; const operation = 'plugin.tool-supply.install';
  const raw = async () => ({ entry: await readFile(join(target, 'entry.txt')), state: await readFile(join(target, '.tool-supply-state.json')) });
  const absent = async (path: string) => { try { await lstat(path); assert.fail('路径应不存在'); } catch (error) { if (object(error).code !== 'ENOENT') throw error; } };
  const run = async (server: Host, name: string, viaMcp = false, data: unknown = input) => {
    const operation = `plugin.tool-supply.${name}`; const job = await server.run(operation, data, viaMcp);
    await audit.recordJob(server, job, 'succeeded', operation);
    if (server !== initial && name === 'install') {
      assert.notEqual(job.id, audit.report.upgrade_job_id); audit.report.recovery_upgrade_job_id = job.id;
    }
    return value(job);
  };
  let original: Awaited<ReturnType<typeof raw>> | undefined;
  let session: Awaited<ReturnType<typeof aclProcess>> | undefined; let released = false; let failedJob: JsonObject | undefined;
  let armed: JsonObject | undefined;
  try {
    await audit.check('v1：真实安装、旧内容与状态原字节基线', async () => {
      source.select(0); assert.equal((await run(initial, 'install')).version, '1.0.0');
      original = await raw(); assert.deepEqual(original.entry, entries[0]);
      const state = object(JSON.parse(original.state.toString('utf8')));
      assert.equal(state.module_id, moduleId); assert.equal(state.version, '1.0.0'); assert.equal(state.sha256, hash(packages[0]));
      await absent(transaction); audit.report.old_identity = await identities(installRoot, [target], []);
    });
    let submitted: JsonObject;
    await audit.check('v2：MCP 同 Job 下载门闩、本轮事务无 content/backup，局部 ACL 已就绪', async () => {
      source.select(1, true); submitted = object(await initial.submit(operation, input, true));
      audit.report.upgrade_job_id = submitted.id; await source.waitGate();
      assert.deepEqual(await raw(), original); await absent(join(transaction, 'content')); await absent(join(transaction, 'backup'));
      assert.deepEqual(await readdir(join(installRoot, '.transactions')), [moduleId]);
      session = await aclProcess(shell, ['-Mode', 'arm', '-Root', root, '-Transaction', transaction, '-PluginExecutable', plugin]);
      audit.report.acl_argv = session.argv;
      armed = await session.next(); audit.report.acl_armed = armed;
      assert.equal(armed.armed, true); assert.equal(armed.watch_ready, true); assert.equal(armed.pid, session.pid);
      const acl = object(armed.transaction_acl); const deny = (acl.deny as unknown[]).map(object);
      assert.ok(deny.some((rule) => rule.inherited === false && rule.propagation === 2 && rule.rights === 65600 && rule.inheritance === 3));
      assert.equal(object(armed.module_lock).acquired, false); assert.equal(object(armed.module_lock).win32_code, 33);
      audit.report.acl_armed_at = new Date().toISOString();
    });
    await audit.check('提交：放行一次下载，旧 target→backup→恢复；新内容/新状态保留在 payload', async () => {
      const releasedAt = Date.now(); source.release();
      failedJob = await initial.finished(String(submitted!.id)); await audit.recordJob(initial, failedJob, 'failed', operation);
      assert.equal(failedJob.status, 'failed');
      await poll(async () => pidAlive(Number(armed!.plugin_pid)), (alive) => !alive, '失败调用的真实插件 PID 退出');
      await source.closed(); session!.command('snapshot'); const snapshot = await session!.next();
      audit.report.commit_snapshot = snapshot;
      assert.equal(failedJob.error, '插件资源清理未确认，请检查外部资源后再恢复', '预期 ACL 拒绝导致公共 cleanup_failed');
      audit.report.independent_order = sequenceEvidence(snapshot, moduleId, true);
      assert.deepEqual(await raw(), original); await absent(join(transaction, 'backup'));
      assert.deepEqual(await readFile(join(payload, 'entry.txt')), entries[1]);
      const state = object(JSON.parse(await readFile(join(payload, '.tool-supply-state.json'), 'utf8')));
      assert.equal(state.module_id, moduleId); assert.equal(state.version, '2.0.0'); assert.equal(state.sha256, hash(packages[1]));
      assert.equal(hash(await readFile(join(transaction, 'archive.zip'))), hash(packages[1]));
      const childAcl = object(snapshot.payload_acl);
      assert.ok((childAcl.deny as unknown[]).map(object).some((rule) => rule.inherited === true && rule.rights === 65600));
      assert.equal(object(snapshot.module_lock).acquired, true); assert.equal(object(snapshot.module_lock).released, true);
      assert.equal(source.calls.filter((call) => call.kind === 'archive' && call.generation === 1).length, 1);
      assert.ok(Date.now() - releasedAt < 15000, '不能把到期窗口误判为提交失败');
      assert.ok(!initial.requests.some((request) => request.action.endsWith('/cancel') || request.action === 'deviceforge.cancel_job'));
      audit.report.restoration = { old_content_and_state_raw_equal: true, backup_owned_by_current_transaction: true,
        backup_absent_after_restore: true, payload_version: '2.0.0', plugin_pid: armed!.plugin_pid, plugin_alive: false,
        module_lock_released: true, plugin_cleanup: 'failed', plugin_cleaned: false,
        evidence: '监听证明新状态创建早于备份，备份随后恢复；ACL 拒绝新目录删除，未发取消且远低于安装期限' };
      audit.report.transaction_retained = await identities(installRoot, [transaction], []);
    });
    await audit.check('清理：卸载 cleanup_failed/draining，旧代重载拒绝，HTTP/MCP 归属一致', async () => {
      const unloaded = await initial.request('/api/v2/plugins/tool-supply/unload', {});
      assert.equal(unloaded.response.status, 409); assert.equal(object(unloaded.error).code, 'cleanup_failed');
      const list = await initial.request('/api/v2/plugins'); assert.equal(list.response.status, 200);
      assert.ok(Array.isArray(list.json)); assert.equal(list.json.length, 1); const owner = object(list.json[0]);
      assert.equal(owner.id, 'tool-supply'); assert.equal(owner.state, 'draining'); assert.equal(owner.cleanup_failed, true);
      assert.deepEqual(await initial.mcp('deviceforge.list_plugins', {}), list.json);
      const reload = await initial.request('/api/v2/plugins/tool-supply/load', {});
      assert.equal(reload.response.status, 409); assert.equal(object(reload.error).code, 'conflict');
      audit.report.retained_owner = { id: owner.id, generation: owner.generation, state: owner.state, cleanup_failed: owner.cleanup_failed };
    });
    try { await normalShutdown(initial, audit, '旧宿主：清理失败仍正常 exit0、端口释放'); }
    finally { markClosed(initial); }
    await audit.check('ACL：恢复访问 ACE、子孙删除拒绝撤销、夹具 PID 正常退出', async () => {
      session!.command('release'); const reply = await session!.next(); audit.report.acl_released = reply;
      assert.equal(reply.released, true); assert.equal(reply.acl_restored, true);
      assert.deepEqual(object(reply.payload_acl).deny, []); session!.eof();
      audit.report.acl_exit = await session!.finish(); released = true;
    });
    await audit.check('人工回收：仅本轮受控事务残留，保留摘要，不计插件 cleaned', async () => {
      assert.deepEqual(await raw(), original); await absent(join(transaction, 'backup'));
      const full = resolve(transaction); assert.ok(full.startsWith(resolve(root) + sep));
      assert.equal(full, resolve(root, 'supply', '.transactions', moduleId));
      for (const path of [root, installRoot, join(installRoot, '.transactions'), transaction, join(transaction, 'content'), payload]) {
        const metadata = await lstat(path); assert.equal(metadata.isSymbolicLink(), false); assert.equal(metadata.isDirectory(), true);
      }
      audit.report.transaction_before_manual_cleanup = await identities(installRoot, [transaction], []);
      assert.deepEqual(audit.report.transaction_before_manual_cleanup, audit.report.transaction_retained);
      await rm(full, { recursive: true }); await absent(transaction); assert.deepEqual(await raw(), original);
      audit.report.manual_cleanup = { performed: true, relative: `supply/.transactions/${moduleId}`, plugin_cleaned: false };
    });
    const recovered = await host(root, privateBin); trackHost(recovered);
    await audit.check('重启：新宿主注册清理正常，旧失败 Job 不被晚到结果改写', async () => {
      await recovered.ready(); const list = await recovered.request('/api/v2/plugins'); assert.equal(list.response.status, 200);
      assert.ok(Array.isArray(list.json)); const owner = object(list.json[0]); assert.equal(owner.cleanup_failed, false);
      assert.equal(owner.id, 'tool-supply'); assert.deepEqual(await recovered.mcp('deviceforge.list_plugins', {}), list.json);
      const history = await recovered.shared(String(failedJob!.id)); assert.equal(history.status, 'failed'); assert.equal(history.error, failedJob!.error);
      audit.report.recovered_owner = { id: owner.id, state: owner.state, generation: owner.generation, cleanup_failed: owner.cleanup_failed };
    });
    await audit.check('恢复业务：新 Job 正常升级 v2、原字节/状态 SHA256、移除与事务清理', async () => {
      source.select(1); const plan = await run(recovered, 'plan', true, { module_ids: [moduleId] });
      assert.equal(object((plan.modules as unknown[])[0]).action, 'update');
      assert.equal((await run(recovered, 'install')).version, '2.0.0'); assert.deepEqual((await raw()).entry, entries[1]);
      const state = object(JSON.parse((await raw()).state.toString('utf8'))); assert.equal(state.version, '2.0.0'); assert.equal(state.sha256, hash(packages[1]));
      await absent(transaction); assert.equal((await run(recovered, 'remove', true)).removed, true); await absent(target); await absent(transaction);
      await recovered.manage('tool-supply', 'unload', true);
      assert.equal(source.calls.filter((call) => call.kind === 'archive' && call.generation === 0).length, 1);
      assert.equal(source.calls.filter((call) => call.kind === 'archive' && call.generation === 1).length, 2);
      audit.report.recovery = { separate_new_job: true, successful_upgrade: true, removed: true,
        original_failed_job: audit.report.upgrade_job_id, recovery_job: audit.report.recovery_upgrade_job_id,
        archive_counts: { v1: 1, failed_v2: 1, explicit_recovery_v2: 1 }, retry_original_job: false };
    });
  } finally {
    if (session && !released) {
      // 失败也撤销本轮 ACL；业务证据、受控残留和报告全部保留，不人工回收。
      try {
        session.eof(); const reply = await session.next(); audit.report.failure_acl_release = reply;
        assert.equal(reply.released, true); assert.equal(reply.acl_restored, true);
        audit.report.failure_acl_exit = await session.finish();
      } catch (error) { audit.report.acl_cleanup_failure = audit.failure(error); }
    }
  }
}
