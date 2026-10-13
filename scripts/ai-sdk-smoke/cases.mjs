import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { poll } from '../device-provider/client.mjs';
import { expectedResult, expectedThread, golden, operation, pluginId, profileName, sdkVersion } from './contracts.mjs';
import { completeCall, finishCall, readJson, readyCall, release, runVersionProbe } from './fixtures.mjs';
import { observeFamily } from './processes.mjs';
import { eventsUntil, finish, jobResult, open, page, preserve, running, submit } from './sessions.mjs';

export async function runtimeStatus(context, modelVerified, pending) {
  const value = pending ? await runVersionProbe(context, pending)
    : await runVersionProbe(context, (async () => jobResult(context, await submit(context, 'runtime.status', {})))());
  const status = pending ? value.data : value;
  assert.equal(status.provider, 'codex_sdk'); assert.equal(status.sdk_version, sdkVersion);
  assert.equal(status.profile, profileName); assert.equal(status.configured, true);
  assert.equal(status.node_version, '24.14.0'); assert.equal(status.cli_version, sdkVersion);
  assert.equal(status.sdk_loaded, true); assert.equal(status.process_scope_qualified, true);
  assert.equal(status.model_verified, modelVerified); assert.equal(status.ready, modelVerified);
  assert.equal(status.resource_scope, 'sdk_worker_proxy_and_cli');
  assert.deepEqual([...status.projects].sort(), Object.keys(context.fixtures).sort());
  context.report.runtime_status.push({ actual: status, simulated_model_qualification: modelVerified, real_model_verified: false });
  context.report.checks.push({ name: modelVerified ? '模拟轮次后隔离运行资格' : '真实版本与官方SDK加载，不凭配置宣布模型就绪', passed: true });
  return value;
}

async function management(context, fixture, action, threadId, turns, flags, transport = 'mcp') {
  const input = { project_id: fixture.label, thread_id: threadId };
  const result = await jobResult(context, await submit(context, 'session.' + action, input, transport));
  assert.deepEqual(result, expectedThread(fixture, threadId, turns, flags));
  return result;
}

export async function ordinary(context) {
  await runtimeStatus(context, false);
  const fixture = context.fixtures.ordinary;
  const first = await submit(context, 'sdk.single', { project_id: fixture.label, prompt: context.prompt });
  const call = await readyCall(context, fixture);
  await release(call, 'start'); await completeCall(call);
  assert.deepEqual(await jobResult(context, first), expectedResult(fixture.label, call.ready.thread_id, 1));
  await finishCall(context, call, 0);
  const threadId = call.ready.thread_id;
  const second = await submit(context, 'sdk.turn', { project_id: fixture.label, prompt: context.prompt, thread_id: threadId.toUpperCase() }, 'mcp');
  const resumed = await readyCall(context, fixture, 2, { threadId });
  await release(resumed, 'start'); await completeCall(resumed);
  assert.deepEqual(await jobResult(context, second), expectedResult(fixture.label, threadId, 2));
  await finishCall(context, resumed, 0);
  await management(context, fixture, 'get', threadId, 2, {}, 'http');
  await management(context, fixture, 'close', threadId, 2, { closed: true });
  context.closedThread = { fixture, threadId };
  const assistant = context.fixtures.assistant;
  const ticket = await submit(context, 'assistant.run', { project_id: assistant.label, user_prompt: context.prompt, stream_output: false }, 'mcp');
  const calls = [];
  for (let ordinal = 1; ordinal <= 4; ordinal++) {
    const current = await readyCall(context, assistant, ordinal, { assistant: true });
    await release(current, 'start'); await completeCall(current); calls.push(current);
  }
  const value = await jobResult(context, ticket);
  assert.deepEqual(value, { ...expectedResult(assistant.label, calls[0].ready.thread_id, 4, 'SDK四轮助手最终回答。'), assistant_turns: '4', stream_output: false });
  for (const current of calls) await finishCall(context, current, 0);
  context.report.checks.push({ name: '普通六贡献HTTP/MCP共享Job与四轮助手真实SDK桥', passed: true });
  await runtimeStatus(context, true);
}

export async function startStream(context, fixture, options = {}) {
  const entry = await open(context, fixture, options);
  const call = await readyCall(context, fixture, options.ordinal ?? 1, { threadId: options.threadId });
  await release(call, 'start');
  await eventsUntil(context, entry, fixture.mode === 'cancel' ? 2 : 8);
  assert.deepEqual(entry.events, golden(call.ready.thread_id).slice(0, entry.events.length));
  await running(context, entry); return { entry, call };
}

export async function candidate(context, current) {
  await release(current.call, 'answer'); await release(current.call, 'continue');
  await readJson(join(current.call.directory, 'provider-candidate.json'), 'CLI真实成功候选原件');
  await eventsUntil(context, current.entry, 9);
  assert.ok(!current.entry.events.some(event => event.type === 'turn.completed'));
  await running(context, current.entry);
  current.entry.provider_candidate_observation = await observeFamily(current.call.family);
  const snapshot = JSON.parse(await readFile(join(context.stateRoot, 'threads', current.call.ready.thread_id + '.json'), 'utf8'));
  assert.equal(snapshot.uncertain, true);
  current.entry.before_resource_exit = { public_turn_completed: false, thread_uncertain: true, turns: snapshot.turns };
}

export async function completeStream(context, fixture, current, turns) {
  await candidate(context, current);
  await release(current.call, 'release-child'); await release(current.call, 'release-grandchild'); await release(current.call, 'exit');
  await finish(context, current.entry, { fixture, threadId: current.call.ready.thread_id, turns, success: true });
  await finishCall(context, current.call, 0);
}

export async function streaming(context) {
  const fixture = context.fixtures.stream;
  const first = await startStream(context, fixture, { caseId: 'HTTP实时SDK候选不提前公开成功' });
  await completeStream(context, fixture, first, 1);
  const second = await startStream(context, fixture, { transport: 'mcp', ordinal: 2, threadId: first.call.ready.thread_id,
    caseId: 'MCP恢复SDK轮次不重放旧提示词' });
  assert.notEqual(second.entry.id, first.entry.id);
  await completeStream(context, fixture, second, 2);
  await management(context, fixture, 'get', first.call.ready.thread_id, 2, {});
  context.retained.push(first.entry, second.entry);
}

export async function failures(context) {
  for (const label of ['nonzero', 'missing', 'late']) {
    const fixture = context.fixtures[label];
    const current = await startStream(context, fixture, { transport: 'mcp', caseId: 'SDK失败-' + label });
    await release(current.call, 'release-child'); await release(current.call, 'release-grandchild');
    await release(current.call, 'answer'); await release(current.call, 'continue');
    if (label !== 'missing') {
      await readJson(join(current.call.directory, 'provider-candidate.json'), '提供者成功候选原件');
      await release(current.call, 'exit');
    }
    await finish(context, current.entry);
    await finishCall(context, current.call, label === 'nonzero' ? 7 : label === 'missing' ? 0 : undefined);
    const snapshot = JSON.parse(await readFile(join(context.stateRoot, 'threads', current.call.ready.thread_id + '.json'), 'utf8'));
    assert.equal(snapshot.uncertain, true); assert.equal(snapshot.turns, 0);
    context.retained.push(current.entry);
  }
}

export async function cancellation(context) {
  const current = await startStream(context, context.fixtures.cancel, { caseId: 'SDK显式取消与全族真实退出' });
  await context.host.client.tool('deviceforge.cancel_session', { id: current.entry.id });
  await finish(context, current.entry); await finishCall(context, current.call);
  context.retained.push(current.entry);
  context.uncertainThread = { fixture: context.fixtures.cancel, threadId: current.call.ready.thread_id };
  const input = { operation, input: { project_id: context.fixtures.cancel.label, prompt: context.prompt, thread_id: null } };
  const invalid = await context.host.client.call('/api/v2/sessions', { method: 'POST', body: JSON.stringify(input) });
  assert.equal(invalid.status, 400); assert.ok(invalid.body.error);
  assert.deepEqual((await readdir(context.fixtures.cancel.root)).filter(name => /^call-\d+$/.test(name)), ['call-01']);
  context.report.checks.push({ name: '显式null线程输入拒绝且未启动第二CLI', passed: true });
}

export async function threadRules(context) {
  const closed = context.closedThread, uncertain = context.uncertainThread;
  const cases = [[context.fixtures.foreign, context.fixtures.foreign.threadIds[7], '未知SDK线程拒绝'],
    [context.fixtures.foreign, closed.threadId, '跨项目SDK线程拒绝'],
    [closed.fixture, closed.threadId, '已关闭SDK线程拒绝'],
    [uncertain.fixture, uncertain.threadId, '取消后uncertainSDK线程拒绝']];
  for (const [fixture, threadId, caseId] of cases) {
    const before = (await readdir(fixture.root)).filter(name => /^call-\d+$/.test(name)).sort();
    const entry = await open(context, fixture, { threadId, caseId });
    await finish(context, entry);
    assert.deepEqual((await readdir(fixture.root)).filter(name => /^call-\d+$/.test(name)).sort(), before,
      '无资格线程必须在新真实CLI启动前拒绝');
    assert.deepEqual(entry.events, []); context.retained.push(entry);
  }
}

export async function lifecycle(context) {
  const current = await startStream(context, context.fixtures.unload, { caseId: 'SDK卸载活动会话真实资源结束' });
  const unloaded = await context.host.client.post(`/api/v2/plugins/${pluginId}/unload`);
  assert.equal(unloaded.state, 'unloaded');
  await finish(context, current.entry); await finishCall(context, current.call); context.retained.push(current.entry);
  assert.ok(!(await context.host.client.tools()).includes(operation));
  assert.deepEqual((await context.host.client.json('/api/v2/session-definitions')).sessions, []);
  for (const entry of context.retained) await preserve(context, entry, '卸载后');
  const loaded = await context.host.client.tool('deviceforge.load_plugin', { id: pluginId });
  assert.notEqual(loaded.generation, context.generation); context.generation = loaded.generation;
  assert.ok((await context.host.client.tools()).includes(operation));
  for (const entry of context.retained) await preserve(context, entry, '新代际后');
  context.report.checks.push({ name: '贡献热撤销、新代重载和旧会话原输出留存', passed: true });
}

export async function shutdown(context) {
  const current = await startStream(context, context.fixtures.shutdown, { caseId: '宿主关闭活动SDK会话真实进程族退出' });
  await context.host.shutdown(); await finishCall(context, current.call);
  current.entry.shutdown_observation = { host_exit_code: context.host.child.exitCode, all_observed_members_exited: true,
    public_finished_query_after_shutdown: false, evidence_source: '真实OS退出与正常关闭后宿主结束日志' };
  context.report.checks.push({ name: '正常宿主关闭结束活动SDK会话、真实进程族和监听', passed: true });
}
