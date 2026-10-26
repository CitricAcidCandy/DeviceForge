import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { poll } from '../device-provider/client.mjs';
import { finishProbe, startProbe } from '../harmony-screenshot-smoke/fixtures.mjs';
import { bounded } from '../unified-discovery-browser/lifecycle.mjs';
import { readIfExists, toolCount } from './fixtures.mjs';
import { ledgerSnapshot } from './ledger.mjs';
import { assertRecoveryView, recoverySummary } from './http.mjs';
import { independentSession } from './isolation.mjs';

// 独立原生进程真实持有插件同一 OS 租约；不声称诱发了生产 ADB 回收失败。
export async function testLeaseDebt(context) {
  const { host, fixture, report } = context;
  assert.ok(context.leaseBinary, '必须显式提供本轮 lease-holder.exe');
  const ledger = await ledgerSnapshot(context);
  const record = ledger.records.find((item) => item.device_id === fixture.device);
  assert.ok(record, '必须由真实插件会话创建资源台账');
  const root = join(host.directory, '..', 'lease-debt');
  await mkdir(root);
  await writeFile(join(root, 'fixture-owner'), '本例原生租约持有者', { flag: 'wx' });
  await writeFile(join(root, 'ledger-root'), ledger.root, { flag: 'wx' });
  await writeFile(join(root, 'token'), record.token, { flag: 'wx' });
  const child = spawn(process.execPath, [fileURLToPath(new URL('./lease-launcher.mjs', import.meta.url)),
    context.leaseBinary, root], { stdio: 'ignore', windowsHide: true });
  const evidence = report.lease_debt = { launcher_pid: child.pid, command: '本轮 lease-holder.exe',
    fixture_root: root, scope: '真实 OS 资源锁、进程锁及持有者存活；不模拟杀真实 ADB 失败' };
  let spawnError, probe;
  child.once('error', (error) => { spawnError = error; });
  const closed = new Promise((done) => child.once('close', (code, signal) => {
    evidence.exit = { code, signal }; done(evidence.exit);
  }));
  try {
    await poll(async () => {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error('原生锁持有者未就绪即退出');
      return readIfExists(join(root, 'ready'));
    }, Boolean, '原生进程实际取得本次 OS 资源锁', 3000);
    const pid = Number(await readFile(join(root, 'ready'), 'utf8'));
    assert.ok(Number.isSafeInteger(pid) && pid > 0); evidence.pid = pid;
    probe = await startProbe(context.probeBinary, pid, join(root, 'process'), await realpath(process.execPath));
    evidence.probe_pid = probe.child.pid; evidence.ready = probe.ready;
    assert.equal(probe.ready.parent.pid, child.pid);
    assert.equal(probe.ready.target.state, 'running');
    assert.equal(child.exitCode, null);
    const count = await toolCount(fixture);
    const result = assertRecoveryView(await host.client.recover(context.generation, fixture.device), {
      generation: context.generation, supported: true,
    });
    assert.equal(result.cleanup_failed, true);
    assert.equal(result.last_report?.status, 'busy');
    assert.ok(result.last_report.remaining > 0);
    assert.equal(await toolCount(fixture), count, '租约仍存活时不能启动清理工具');
    assert.equal(child.exitCode, null, '恢复不得终止原生租约持有者');
    report.recovery_views.push(recoverySummary(result));
    await independentSession(context);
    assert.equal(child.exitCode, null, '跨设备新调用成功也不能终止旧资源的真实租约持有者');
    evidence.risk_preserved_while_alive = true;
    await writeFile(join(root, 'release'), '1', { flag: 'wx' });
    assert.deepEqual(await bounded(closed, 3000, '原生租约持有者正常退出超时'), { code: 0, signal: null });
    assert.equal((await readFile(join(root, 'released'), 'utf8')), '1');
    const before = await ledgerSnapshot(context);
    assert.ok(before.records.some((item) => item.token === record.token), '持有者退出不应自动删除台账');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      evidence.failure_self_exit = true;
      await writeFile(join(root, 'stop-fixture'), '1');
      try { await bounded(closed, 2000, '原生锁持有者失败自退超时'); }
      catch {
        evidence.forced_own_child_termination = true; child.kill();
        await bounded(closed, 2000, '原生锁持有者回收超时');
      }
    }
    if (probe) {
      evidence.process = await bounded(finishProbe(probe), 3000, '原生租约持有者及父进程探针退出超时');
      assert.equal(evidence.process.exit.target.state, 'exited');
      assert.equal(evidence.process.exit.parent.state, 'exited');
      assert.equal(evidence.process.exit.parent.exit_code, 0);
      assert.equal(evidence.process.exit.target.exit_code, 0);
    }
  }
}
