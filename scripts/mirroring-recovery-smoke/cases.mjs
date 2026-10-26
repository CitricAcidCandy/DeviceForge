import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { assertRecoveryView, recoveryPath, recoverySummary } from './http.mjs';
import { assertNoOwnedResources, fixtureState, setMode, toolCount } from './fixtures.mjs';
import { runRecoveryCase } from './recovery-cases.mjs';
import { settleFailedCompletion } from './completion.mjs';
import { independentSession, ownedResourceState } from './isolation.mjs';

export async function readView(context, supported = true) {
  const view = assertRecoveryView(await context.host.client.recovery(), {
    generation: context.generation, supported,
  });
  context.report.recovery_views.push({ observed_at: new Date().toISOString(), ...recoverySummary(view) });
  return view;
}

async function plugin(context) {
  const value = (await context.host.client.json('/api/v2/plugins')).find((item) => item.id === 'mirroring');
  assert.ok(value);
  assert.equal(value.generation, context.generation);
  return value;
}

export async function makeRisk(context, device = context.fixture.device) {
  await setMode(context.fixture, device, 'success');
  const opened = await context.sessions.open(device);
  await setMode(context.fixture, device, 'list-always');
  await context.sessions.cancel(opened, 'failed');
  assert.equal((await plugin(context)).cleanup_failed, true);
  await settleFailedCompletion(context);
  return opened;
}

export async function runScenario(context) {
  const { name, host, report, fixture, sessions } = context;
  context.stage = '恢复 HTTP 视图合同';
  const initial = await readView(context, name !== 'unsupported');
  assert.equal(initial.cleanup_failed, false);
  assert.equal(initial.recovering, false);
  assert.equal(initial.last_report, null, '独占新插件不应带入旧报告');

  if (name === 'contract-view') {
    assert.equal(await toolCount(fixture), 0, '只读视图不得探测或操作设备');
    report.checks.push('恢复视图、声明和只读无副作用');
    return;
  }
  if (name === 'stale-generation') {
    context.stage = '推进同 ID 的真实插件代次';
    const old = context.generation;
    await host.client.post('/api/v2/plugins/mirroring/unload');
    const loaded = await host.client.post('/api/v2/plugins/mirroring/load');
    context.generation = loaded.generation;
    assert.notEqual(context.generation, old);
    report.old_generation = old;
    report.current_generation = context.generation;
    const count = await toolCount(fixture);
    for (const generation of [old, randomUUID()]) {
      const reply = await host.client.call(recoveryPath, { method: 'POST',
        input: { generation, input: { device_id: fixture.device } } });
      assert.equal(reply.status, 409, '旧代次及未知代次须拒绝');
      assert.ok(reply.body.error && typeof reply.body.error.code === 'string');
    }
    assert.equal(await toolCount(fixture), count, '错误代次不得启动工具');
    const current = await readView(context);
    assert.equal(current.cleanup_failed, false);
    assert.equal(current.last_report, null, '旧代次恢复不得发布报告');
    report.checks.push('旧实际代次与随机代次都拒绝，未执行设备命令');
    return;
  }
  if (name === 'unsupported') {
    context.stage = '未声明恢复时产生真实清理失败';
    await makeRisk(context);
    const before = await readView(context, false);
    assert.equal(before.cleanup_failed, true);
    const count = await toolCount(fixture);
    const state = await fixtureState(fixture, fixture.device);
    const denied = await host.client.call(recoveryPath, { method: 'POST',
      input: { generation: context.generation, input: { device_id: fixture.device } } });
    assert.ok(denied.status >= 400 && denied.status < 500, '不支持恢复的插件必须明确拒绝');
    assert.ok(denied.body.error);
    assert.equal(await toolCount(fixture), count, '不支持请求不得启动工具');
    const after = await readView(context, false);
    assert.equal(after.cleanup_failed, true);
    assert.equal(after.recovering, false);
    assert.deepEqual(await fixtureState(fixture, fixture.device), state);
    await independentSession(context);
    assert.equal((await plugin(context)).cleanup_failed, true);
    report.checks.push('不支持恢复时仅恢复接口拒绝，独立新会话成功且保留旧资源诊断');
    return;
  }
  if (name === 'active-session-recovery') {
    context.stage = '活跃媒体会话中的恢复请求';
    const active = await sessions.open();
    const before = await fixtureState(fixture, fixture.device);
    const view = assertRecoveryView(await host.client.recover(context.generation, fixture.device), {
      generation: context.generation, supported: true, freshReport: true,
    });
    assert.equal(view.last_report?.status, 'recovered');
    assert.ok(view.last_report.inspected >= 1 && view.last_report.checks.length > 0,
      '恢复必须实际扫描并报告活跃资源，不能在宿主准入处全局返回 busy');
    assert.equal(view.recovering, false);
    assert.equal(view.cleanup_failed, false);
    assert.equal((await host.client.json(`/api/v2/sessions/${active.id}`)).status, 'running');
    assert.deepEqual(ownedResourceState(await fixtureState(fixture, fixture.device)), ownedResourceState(before),
      '恢复扫描不得释放、覆盖活跃新会话资源');
    report.recovery_views.push(recoverySummary(view));
    await sessions.cancel(active, 'complete');
    await assertNoOwnedResources(fixture, fixture.device);
    assert.equal((await plugin(context)).cleanup_failed, false);
    report.checks.push('活跃新会话期间实际扫描旧资源，跳过新资源且用户取消后正常清理');
    return;
  }
  await runRecoveryCase(context);
}
