// 首次 cli.turn 建立持久归属；不虚构 session.create 或真实模型调用。
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { object, tool, value, type Host } from './six-business-support.ts';
import type { Reporter } from './ordinary-business-report.ts';

export const aiThread = '12345678-1234-1234-1234-123456789abc';
const singleThread = '22345678-1234-1234-1234-123456789abc';
const events = (thread: string) => [
  { type: 'thread.started', thread_id: thread },
  { type: 'item.completed', item: { type: 'agent_message', text: '合成模型固定回答' } },
  { type: 'turn.completed' },
].map((event) => JSON.stringify(event)).join('\n') + '\n';
export async function aiCases(host: Host, cli: Awaited<ReturnType<typeof tool>>, audit: Reporter, extended = false) {
  const session = { project_id: 'fixture', thread_id: aiThread };
  let count = 0;
  const run = async (name: string, input: unknown, viaMcp = false, expected = 'succeeded') => {
    const operation = `plugin.ai-assistant.${name}`; const job = await host.run(operation, input, viaMcp);
    await audit.recordJob(host, job, expected, operation); assert.equal(job.status, expected); return job;
  };
  const invoke = async (name: 'cli.single' | 'cli.turn', thread: string, resume: boolean, viaMcp: boolean, hold = false) => {
    count += 1; const index = count; const prompt = `设备工坊合成提示/轮次${index}`;
    await cli.reply(index, events(thread), hold);
    const pending = object(await host.submit(`plugin.ai-assistant.${name}`, { project_id: 'fixture', prompt,
      ...(resume ? { thread_id: thread.toUpperCase() } : {}) }, viaMcp));
    await cli.wait(index);
    assert.deepEqual(await cli.args(index), resume ? ['exec', 'resume', '--json', thread, '--fixture', '-'] : ['exec', '--json', '--fixture', '-']);
    assert.equal(await cli.input(index), Buffer.byteLength(prompt));
    return pending;
  };
  const evidence = async (index: number, cancelled = false) => {
    const item = await cli.evidence(index); assert.equal(item.host_token_inherited, false);
    if (!cancelled) assert.equal(item.normal_exit, '0');
    (audit.report.tools as unknown[]).push(item); await audit.flush();
  };
  await audit.check('AI：运行状态及首次 turn 建立持久线程归属', async () => {
    const status = value(await run('runtime.status', {}, true)); assert.equal(status.configured, true);
    assert.deepEqual(status.projects, ['fixture', 'other']);
    const pending = await invoke('cli.turn', aiThread, false, false);
    const job = await host.finished(String(pending.id)); await audit.recordJob(host, job, 'succeeded', 'plugin.ai-assistant.cli.turn');
    const result = value(job); assert.equal(result.thread_id, aiThread); assert.equal(result.project_id, 'fixture');
    assert.equal(result.text, '合成模型固定回答'); await evidence(count);
    const saved = value(await run('session.get', session, true));
    assert.equal(saved.turns, '1'); assert.equal(saved.closed, false); assert.equal(saved.uncertain, false);
  });
  await audit.check('AI：跨项目和未知线程拒绝，不启动 CLI', async () => {
    await run('cli.turn', { ...session, project_id: 'other', prompt: '设备工坊合成提示/跨项目' }, true, 'failed');
    await run('cli.turn', { ...session, thread_id: '32345678-1234-1234-1234-123456789abc', prompt: '设备工坊合成提示/未知线程' }, false, 'failed');
    assert.equal((await readdir(cli.directory)).filter((name) => /^call-\d+$/.test(name)).length, count);
  });
  await audit.check('AI：卸载重载后归属恢复及大小写 UUID 归一', async () => {
    await host.manage('ai-assistant', 'unload', true); await host.manage('ai-assistant', 'load');
    assert.equal(value(await run('session.get', { ...session, thread_id: aiThread.toUpperCase() })).turns, '1');
    const pending = await invoke('cli.turn', aiThread, true, true);
    const job = await host.finished(String(pending.id)); await audit.recordJob(host, job, 'succeeded', 'plugin.ai-assistant.cli.turn');
    assert.equal(value(job).thread_id, aiThread); await evidence(count);
    assert.equal(value(await run('session.get', session, true)).turns, '2');
  });
  await audit.check('AI：独立 single 轮次与 session.close 拒绝续跑', async () => {
    const pending = await invoke('cli.single', singleThread, false, true);
    const job = await host.finished(String(pending.id)); await audit.recordJob(host, job, 'succeeded', 'plugin.ai-assistant.cli.single');
    assert.equal(value(job).thread_id, singleThread); await evidence(count);
    const single = { project_id: 'fixture', thread_id: singleThread };
    assert.equal(value(await run('session.close', single)).closed, true);
    await run('cli.turn', { ...single, prompt: '设备工坊合成提示/已关闭线程' }, true, 'failed');
    assert.equal((await readdir(cli.directory)).filter((name) => /^call-\d+$/.test(name)).length, count);
  });
  if (!extended) return;
  await audit.check('AI：真实开始后 MCP 取消、PID 退出、uncertain 禁止重放', async () => {
    const pending = await invoke('cli.turn', aiThread, true, false, true);
    await host.cancel(String(pending.id), true);
    const job = await host.finished(String(pending.id)); await audit.recordJob(host, job, 'cancelled', 'plugin.ai-assistant.cli.turn');
    assert.equal(job.status, 'cancelled'); await evidence(count, true);
    const snapshot = value(await run('session.get', session, true)); assert.equal(snapshot.uncertain, true); assert.equal(snapshot.turns, '2');
    await run('cli.turn', { ...session, prompt: '设备工坊合成提示/禁止重放' }, false, 'failed');
    assert.equal((await readdir(cli.directory)).filter((name) => /^call-\d+$/.test(name)).length, count);
    assert.equal(value(await run('session.close', session, true)).closed, true);
  });
}
