import assert from 'node:assert/strict';
import { poll } from '../device-provider/client.mjs';
import { assertRecoveryView, recoverySummary } from './http.mjs';
import { assertNoOwnedResources, fixtureState, setMode } from './fixtures.mjs';
import { holdRecovery } from './recovery-contract.mjs';
import { archiveCleanSession } from './reset-fixture.mjs';
import { testLeaseDebt } from './lease-debt.mjs';

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
  if (name === 'cross-device-partial') {
    await setMode(fixture, fixture.nextDevice, 'list-always');
    const other = await sessions.open(fixture.nextDevice);
    await risk(first);
    await risk(other);
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
    report.denied_open = await sessions.openDenied();
    report.checks.push('按插件核对两设备；B 仍失败时全局风险保持');
    return;
  }
  if (name === 'foreign-forward') await setMode(fixture, fixture.device, 'foreign-forward');
  if (name === 'pid-mismatch') await setMode(fixture, fixture.device, 'pid-mismatch');
  await risk(first);
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
  if (['explicit-recovery', 'automatic-recovery', 'recovering-blocks-open'].includes(name))
    await setMode(fixture, fixture.device, 'success');

  if (name === 'recovering-blocks-open') {
    context.stage = '恢复进行中的会话互斥';
    const gate = await holdRecovery(context);
    let pending;
    try {
      pending = recover();
      pending.catch(() => {});
      await poll(view, (item) => item.recovering, '恢复正在执行');
      report.denied_open = await sessions.openDenied();
      assert.equal((await view()).recovering, true);
    } finally { await gate.release(); }
    const final = await pending;
    assert.equal(final.last_report?.status, 'recovered');
  } else if (name === 'automatic-recovery') {
    // 未直接调用恢复端点：下一次真实准入必须先核对并清偿旧资源债务。
    await archiveCleanSession(fixture, fixture.device, { requireClean: false });
    const next = await sessions.open();
    assert.equal((await view()).cleanup_failed, false);
    await sessions.cancel(next, 'complete');
    await assertNoOwnedResources(fixture, fixture.device);
    report.checks.push('自动恢复在原代次重新准入，未调用显式恢复');
    return;
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
      report.denied_open = await sessions.openDenied();
      report.checks.push('未确认资源保持阻断，后续会话不准入');
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
