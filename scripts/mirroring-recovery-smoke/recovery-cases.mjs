import assert from 'node:assert/strict';
import { poll } from '../device-provider/client.mjs';
import { assertRecoveryView, recoverySummary } from './http.mjs';
import { assertNoOwnedResources, fixtureState, setMode } from './fixtures.mjs';
import { holdRecovery } from './recovery-contract.mjs';
import { archiveCleanSession } from './reset-fixture.mjs';
import { testLeaseDebt } from './lease-debt.mjs';
import { settleFailedCompletion } from './completion.mjs';
import { independentSession, ownedResourceState } from './isolation.mjs';
import { ledgerSnapshot } from './ledger.mjs';

// 精确恢复命令合同未交接时，入口将整例标为待交接，不执行以下流程。
export async function runRecoveryCase(context) {
  const { name, host, fixture, report, sessions } = context;
  const view = async () => assertRecoveryView(await host.client.recovery(), { generation: context.generation, supported: true });
  const recover = async () => {
    context.stage = '执行并核对插件级显式恢复';
    const value = assertRecoveryView(await host.client.recover(context.generation, fixture.device), {
      generation: context.generation, supported: true, freshReport: true,
    });
    report.recovery_views.push(recoverySummary(value));
    return value;
  };
  const risk = async (entry) => {
    await sessions.cancel(entry, 'failed');
    assert.equal((await view()).cleanup_failed, true);
  };
  context.stage = '准备真实持久资源债务';
  const first = await sessions.open();
  if (name === 'completion-recovery') {
    await setMode(fixture, fixture.device, 'list-pair');
    await sessions.cancel(first, 'failed');
    const final = await poll(view, (value) => !value.cleanup_failed && !value.recovering &&
      value.last_report?.status === 'recovered', '清理失败后无需下一次打开即有界后台恢复', 110000);
    assert.equal(final.last_report.remaining, 0);
    assert.equal(report.requests.some((item) => item.method === 'POST' && item.path.endsWith('/recovery')), false);
    await assertNoOwnedResources(fixture, fixture.device);
    await archiveCleanSession(fixture, fixture.device);
    await setMode(fixture, fixture.device, 'success');
    const next = await sessions.open(); await sessions.cancel(next, 'complete');
    report.checks.push('同代会话 Failed 后最多三次后台续办完成，无显式恢复 POST、无需下一次 open 触发');
    return;
  }
  if (name === 'cross-device-partial') {
    const other = await sessions.open(fixture.nextDevice);
    await setMode(fixture, fixture.device, 'list-always');
    await setMode(fixture, fixture.nextDevice, 'list-always');
    await risk(first);
    await risk(other);
    await settleFailedCompletion(context);
    await setMode(fixture, fixture.device, 'success');
    const beforeB = await fixtureState(fixture, fixture.nextDevice);
    const result = await recover();
    assert.equal(result.last_report?.status, 'blocked');
    assert.ok(result.last_report.inspected >= 2 && result.last_report.remaining >= 1);
    assert.equal(result.cleanup_failed, true, 'A 成功不能抹掉 B 的债务');
    assert.ok(result.last_report.checks.some((item) => item.status === 'blocked'));
    await assertNoOwnedResources(fixture, fixture.device);
    const afterB = await fixtureState(fixture, fixture.nextDevice);
    for (const key of ['forward-owned', 'forward-device', 'forward-scid']) assert.equal(afterB[key], beforeB[key]);
    await archiveCleanSession(fixture, fixture.device);
    await independentSession(context, { device: fixture.device, debtDevice: fixture.nextDevice });
    report.checks.push('按旧资源处理：A 已恢复即允许同代重开，B 失败仅保留其债务而不封锁 A');
    return;
  }
  if (name === 'foreign-forward') await setMode(fixture, fixture.device, 'foreign-forward');
  else if (name === 'pid-mismatch') await setMode(fixture, fixture.device, 'pid-mismatch');
  else await setMode(fixture, fixture.device, 'list-always');
  await risk(first);
  await settleFailedCompletion(context);
  const state = await fixtureState(fixture, fixture.device);
  if (name === 'tool-lease-debt') {
    await testLeaseDebt(context);
    await setMode(fixture, fixture.device, 'success');
    const result = await recover();
    assert.equal(result.last_report?.status, 'recovered');
    await assertNoOwnedResources(fixture, fixture.device);
    await archiveCleanSession(fixture, fixture.device);
    const next = await sessions.open();
    await sessions.cancel(next, 'complete');
    await assertNoOwnedResources(fixture, fixture.device);
    report.checks.push('真实租约存活时 busy 保留风险且不杀持有者，归还后同代恢复并重开');
    return;
  }
  if (name === 'independent-reopen') {
    const before = report.requests.filter((item) => item.method === 'POST' && item.path.endsWith('/recovery')).length;
    await independentSession(context);
    assert.equal(report.requests.filter((item) => item.method === 'POST' && item.path.endsWith('/recovery')).length, before);
    report.checks.push('旧故障保持原样，新调用不等待打开前全局恢复，也未重放恢复 POST');
    return;
  }
  if (['explicit-recovery', 'recovering-allows-open'].includes(name))
    await setMode(fixture, fixture.device, 'success');

  if (name === 'recovering-allows-open') {
    context.stage = '旧恢复真实挂起时启动新独立会话';
    const gate = await holdRecovery(context);
    let pending, next, nextResources;
    try {
      pending = recover();
      pending.catch(() => {});
      await poll(view, (item) => item.recovering, '恢复正在执行');
      await gate.wait();
      next = await sessions.open(fixture.nextDevice);
      nextResources = ownedResourceState(await fixtureState(fixture, fixture.nextDevice));
      assert.equal((await view()).recovering, true);
    } finally { await gate.release(); }
    const final = await pending;
    await assertNoOwnedResources(fixture, fixture.device);
    const ledger = await ledgerSnapshot(context);
    assert.equal(ledger.records.some((record) => record.device_id === fixture.device), false,
      '新 active 不能阻止已确认旧台账逐项撤销');
    assert.ok(ledger.records.some((record) => record.device_id === fixture.nextDevice),
      '旧确认不能撤销新 active 台账');
    assert.equal((await host.client.json(`/api/v2/sessions/${next.id}`)).status, 'running');
    assert.deepEqual(ownedResourceState(await fixtureState(fixture, fixture.nextDevice)), nextResources,
      '晚到旧恢复不得释放、覆盖或关闭新 active 资源');
    report.late_recovery = { ...recoverySummary(final), new_session_still_running: true,
      old_ledger_removed: true, new_ledger_preserved: true };
    await sessions.cancel(next, 'complete');
    await assertNoOwnedResources(fixture, fixture.nextDevice);
    if (context.completionRecovery) {
      await poll(view, (item) => !item.recovering && !item.cleanup_failed,
        '新调用真实结束后后台完成剩余诊断确认', 110000);
    } else {
      assert.equal((await recover()).cleanup_failed, false);
    }
    report.checks.push('恢复真实挂起期间新会话正常输出；旧恢复完成后仅旧台账撤销，新资源继续持有至自身退出');
  } else if (['explicit-recovery', 'repeated-failure', 'foreign-forward', 'pid-mismatch'].includes(name)) {
    const result = await recover();
    if (name !== 'explicit-recovery') {
      assert.equal(result.last_report?.status, 'blocked');
      assert.equal(result.cleanup_failed, true);
      assert.ok(result.last_report.remaining >= 1);
      const after = await fixtureState(fixture, fixture.device);
      if (name === 'foreign-forward') {
        for (const key of ['forward-owned', 'forward-device', 'forward-scid', 'foreign-original']) assert.equal(after[key], state[key]);
      }
      if (name === 'pid-mismatch') {
        for (const key of ['remote-dir', 'remote-pid', 'remote-owner']) assert.equal(after[key], state[key]);
        assert.equal(after['remote-cleaned'], null, '身份不符不得删除远端目录');
      }
      if (name === 'repeated-failure') {
        assert.equal((await recover()).cleanup_failed, true);
        assert.equal(after['forward-owned'], state['forward-owned']);
      }
      await independentSession(context);
      report.checks.push('未确认旧资源继续保留，新设备独立会话正常准入且不改写旧债务');
      return;
    }
    assert.equal(result.last_report?.status, 'recovered');
  } else {
    throw new Error('此反例等待协议夹具交接，不允许以其他恢复案例替代');
  }
  assert.equal((await view()).cleanup_failed, false);
  await assertNoOwnedResources(fixture, fixture.device);
  await archiveCleanSession(fixture, fixture.device);
  const next = await sessions.open();
  await sessions.cancel(next, 'complete');
  await assertNoOwnedResources(fixture, fixture.device);
  report.checks.push('恢复成功并在原代次、同一模拟设备再次打开及完整清理');
}
