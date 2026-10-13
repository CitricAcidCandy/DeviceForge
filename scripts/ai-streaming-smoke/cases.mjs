import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { poll } from '../device-provider/client.mjs';
import { operation, prompt } from './contracts.mjs';
import { assertNoCalls, assertSnapshot, finishCall, observeRunning, readyCall, release } from './fixtures.mjs';
import { finish, management, open, page, preserve, remove, running, untilEvent } from './sessions.mjs';

export async function start(context, fixture, options) {
  const entry = await open(context, fixture, options);
  const call = await readyCall(context, fixture, options?.ordinal ?? 1, Boolean(options?.threadId), entry);
  await release(call, 'start');
  await untilEvent(context, entry, 'item.started');
  await poll(async () => {
    const value = await page(context, entry);
    return value;
  }, () => entry.events.length === 7, '退出前七项规范事件');
  await running(context, entry);
  assert.notEqual(entry.id, fixture.threadId);
  await assertSnapshot(fixture, context.stateRoot, { turns: options?.previousTurns ?? 0, uncertain: true });
  return { entry, call };
}

export async function complete(context, fixture, current, turns) {
  await release(current.call, 'continue');
  await untilEvent(context, current.entry, 'turn.completed');
  await running(context, current.entry);
  const alive = await observeRunning(current.call);
  current.entry.provider_completion_observation = alive;
  await assertSnapshot(fixture, context.stateRoot, { turns: turns - 1, uncertain: true });
  await release(current.call, 'exit');
  await finish(context, current.entry, { fixture, turns, success: true });
  await finishCall(context, current.call, 0);
  await assertSnapshot(fixture, context.stateRoot, { turns, uncertain: false });
}

export async function normal(context) {
  const fixture = context.fixtures.normal;
  const first = await start(context, fixture, { caseId: 'HTTP新线程、增量、EOF及成功提交' });
  const receipt = await context.host.client.post(`/api/v2/sessions/${first.entry.id}/eof`);
  assert.deepEqual(receipt, { id: first.entry.id, accepted: true });
  await running(context, first.entry);
  await complete(context, fixture, first, 1);
  await management(context, fixture, 'get', { turns: '1', closed: false, uncertain: false });
  const resumed = await start(context, fixture, { transport: 'mcp', threadId: fixture.threadId.toUpperCase(),
    ordinal: 2, previousTurns: 1, caseId: 'MCP同线程新传输会话与第二轮' });
  assert.notEqual(resumed.entry.id, first.entry.id);
  assert.deepEqual(await context.host.client.tool('deviceforge.session_eof', { id: resumed.entry.id }),
    { id: resumed.entry.id, accepted: true });
  await running(context, resumed.entry);
  await complete(context, fixture, resumed, 2);
  await management(context, fixture, 'get', { turns: '2', closed: false, uncertain: false });
  await preserve(context, first.entry, '第二轮完成后保留第一轮');
  await remove(context, resumed.entry);
  context.retained.push(first.entry);
  context.normalFixture = fixture;
  context.report.checks.push({ name: '提供者完成后工具仍活、持久uncertain，零退出后才Finished', passed: true });
}

export async function failedProviders(context) {
  for (const mode of ['nonzero', 'partial', 'late']) {
    const fixture = context.fixtures[mode];
    const current = await start(context, fixture, { transport: 'mcp', caseId: '提供者失败-' + mode });
    await release(current.call, 'continue');
    if (mode !== 'partial') {
      await untilEvent(context, current.entry, 'turn.completed');
      await running(context, current.entry);
      current.entry.provider_completion_observation = await observeRunning(current.call);
      await assertSnapshot(fixture, context.stateRoot, { turns: 0, uncertain: true });
      await release(current.call, 'exit');
    }
    await finish(context, current.entry, { error: mode === 'partial' ? /缺少完整/ : mode === 'late' ? /完成后仍返回事件/ : /未成功退出/ });
    await finishCall(context, current.call, mode === 'nonzero' ? 7 : mode === 'partial' ? 0 : undefined);
    await assertSnapshot(fixture, context.stateRoot, { turns: 0, uncertain: true });
    await management(context, fixture, 'get', { turns: '0', closed: false, uncertain: true });
    await remove(context, current.entry);
  }
}

export async function refusedInput(context) {
  const fixture = context.fixtures.input;
  const current = await start(context, fixture, { caseId: '追加Input拒绝并清理' });
  assert.deepEqual(await context.host.client.post(`/api/v2/sessions/${current.entry.id}/input`, { bytes: [65, 73] }),
    { id: current.entry.id, accepted: true });
  await finish(context, current.entry, { error: /不接受追加Input/ });
  await finishCall(context, current.call);
  await assertSnapshot(fixture, context.stateRoot, { turns: 0, uncertain: true });
  assert.deepEqual((await readdir(fixture.root)).filter(name => /^call-\d+$/.test(name)), ['call-01']);
  await remove(context, current.entry);
}

export async function cancelledAndLocked(context) {
  const fixture = context.fixtures.cancel;
  const current = await start(context, fixture, { caseId: '显式取消与直接工具清理' });
  const waiting = await open(context, fixture, { transport: 'mcp', threadId: fixture.threadId.toUpperCase(), caseId: '同线程并发等待后uncertain拒绝' });
  await poll(() => context.host.client.json(`/api/v2/sessions/${waiting.id}`), value => value.status === 'running', '同线程第二会话已准入');
  const blocked = await page(context, waiting);
  assert.deepEqual(blocked.chunks, []);
  assert.deepEqual((await readdir(fixture.root)).filter(name => /^call-\d+$/.test(name)), ['call-01']);
  await context.host.client.tool('deviceforge.cancel_session', { id: current.entry.id });
  await finish(context, current.entry, { error: /取消/ });
  await finishCall(context, current.call);
  await finish(context, waiting, { error: /上一轮未确认完成/ });
  assert.deepEqual((await readdir(fixture.root)).filter(name => /^call-\d+$/.test(name)), ['call-01']);
  await assertSnapshot(fixture, context.stateRoot, { turns: 0, uncertain: true });
  await remove(context, current.entry);
  await remove(context, waiting);
}

async function rejected(context, fixture, options, expected) {
  const entry = await open(context, fixture, options);
  await finish(context, entry, { error: expected });
  await remove(context, entry);
  return entry;
}

export async function threadRules(context) {
  const unknown = context.fixtures.unknown;
  await rejected(context, unknown, { threadId: unknown.threadId, caseId: '未知线程拒绝' }, /未登记/);
  await assertNoCalls(unknown);
  const foreign = context.fixtures.foreign;
  await rejected(context, foreign, { threadId: context.normalFixture.threadId, caseId: '跨项目线程拒绝' }, /不属于该项目/);
  await assertNoCalls(foreign);
  const uncertain = context.fixtures.input;
  await rejected(context, uncertain, { threadId: uncertain.threadId, caseId: 'uncertain不自动重放' }, /上一轮未确认完成/);
  assert.deepEqual((await readdir(uncertain.root)).filter(name => /^call-\d+$/.test(name)), ['call-01']);
  await management(context, context.normalFixture, 'close', { turns: '2', closed: true, uncertain: false });
  await rejected(context, context.normalFixture, { threadId: context.normalFixture.threadId, caseId: '已关闭线程拒绝' }, /已关闭/);
  assert.deepEqual((await readdir(context.normalFixture.root)).filter(name => /^call-\d+$/.test(name)), ['call-01', 'call-02']);
  const invalid = await context.host.client.call('/api/v2/sessions', { method: 'POST', body: JSON.stringify({ operation,
    input: { project_id: unknown.label, prompt, thread_id: null } }) });
  assert.equal(invalid.status, 400);
  assert.ok(invalid.body.error);
  await assertNoCalls(unknown);
  context.report.checks.push({ name: 'Open显式null拒绝且无工具启动', passed: true });
}

export async function lifecycle(context) {
  const unloading = await start(context, context.fixtures.unload, { caseId: '卸载等待活动AI轮次清理' });
  const unloaded = await context.host.client.post('/api/v2/plugins/ai-assistant/unload');
  assert.equal(unloaded.state, 'unloaded');
  await finish(context, unloading.entry, { error: /取消/ });
  await finishCall(context, unloading.call);
  await assertSnapshot(context.fixtures.unload, context.stateRoot, { turns: 0, uncertain: true });
  context.retained.push(unloading.entry);
  assert.ok(!(await context.host.client.tools()).includes(operation));
  assert.deepEqual((await context.host.client.json('/api/v2/session-definitions')).sessions, []);
  for (const entry of context.retained) await preserve(context, entry, '卸载后');
  const reloaded = await context.host.client.tool('deviceforge.load_plugin', { id: 'ai-assistant' });
  assert.notEqual(reloaded.generation, context.generation);
  context.generation = reloaded.generation;
  assert.ok((await context.host.client.tools()).includes(operation));
  for (const entry of context.retained) await preserve(context, entry, '新代重载后');
  assert.deepEqual(await context.host.client.tool('deviceforge.list_sessions', {}), await context.host.client.json('/api/v2/sessions'));
  context.report.checks.push({ name: '动态撤销、重载新代、旧会话输出与持久线程保留', passed: true });
  const shutdown = await start(context, context.fixtures.shutdown, { caseId: '宿主关闭活动AI轮次' });
  await context.host.shutdown();
  await finishCall(context, shutdown.call);
  await assertSnapshot(context.fixtures.shutdown, context.stateRoot, { turns: 0, uncertain: true });
  context.report.checks.push({ name: '宿主关闭、工具与插件真实退出、监听释放', passed: true });
}
