// 旧债务诊断与新调用结果分别核对，不通过覆盖旧模拟资源制造新调用成功。
import assert from 'node:assert/strict';
import { assertRecoveryView, recoverySummary } from './http.mjs';
import { assertNoOwnedResources, fixtureState } from './fixtures.mjs';

const resourceKeys = [
  'expected-dir', 'remote-dir', 'remote-pid', 'remote-owner', 'remote-cleaned',
  'port', 'scid', 'forward-owned', 'forward-device', 'forward-scid',
  'forward-removed', 'foreign-original',
];

export function ownedResourceState(state) {
  return Object.fromEntries(resourceKeys.map((key) => [key, state[key]]));
}

export async function independentSession(context, {
  device = context.fixture.nextDevice, debtDevice = context.fixture.device,
} = {}) {
  const { host, fixture, report, sessions } = context;
  assert.notEqual(device, debtDevice, '本例独立设备不能覆盖旧债务的模拟文件');
  const before = ownedResourceState(await fixtureState(fixture, debtDevice));
  context.stage = '旧清理债务未消失时启动独立设备真实新调用';
  const next = await sessions.open(device);
  assert.equal((await host.client.json(`/api/v2/sessions/${next.id}`)).status, 'running');
  await sessions.cancel(next, 'complete');
  await assertNoOwnedResources(fixture, device);
  assert.deepEqual(ownedResourceState(await fixtureState(fixture, debtDevice)), before,
    '新成功不得认领、删除或重写旧失败设备资源');
  const current = assertRecoveryView(await host.client.recovery(), { generation: context.generation });
  assert.equal(current.cleanup_failed, true, '独立新成功不能抹掉旧债务诊断');
  report.recovery_views.push(recoverySummary(current));
  (report.independent_calls ??= []).push({ session_id: next.id, generation: next.generation,
    process_exited: next.final.completion.process_exited,
    cleanup: next.final.completion.cleanup, old_resources_preserved: true,
    historical_warning_preserved: true });
  report.checks.push('旧债务仍存在时跨设备新调用实际输出、正常结束并真实退出，旧资源与诊断均保留');
  return next;
}
