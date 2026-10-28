import test from 'node:test';
import assert from 'node:assert/strict';
import plugin from '../browser/src/index.js';
import { mount } from '../browser/src/mount.js';
import { localEcho, serverEcho } from '../browser/src/echo.js';
import { fixture, tick } from './helpers.mjs';

test('公开贡献身份独立，追加槽位与自有页面替换分开', () => {
  assert.equal(plugin.apiVersion, 2);
  const groups = [plugin.panels, ...Object.values(plugin.contributions)];
  const ids = groups.flatMap((group) => group.map((entry) => entry.id));
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(plugin.contributions.components.map(({ slot, mode }) => ({ slot, mode })), [
    { slot: 'developer.tools', mode: 'append' }, { slot: 'page.demo.debugger.browser.echo', mode: 'replace' },
  ]);
  assert.equal(plugin.contributions.modules[0].route, '/echo');
  assert.equal(plugin.contributions.services[0].version, '1');
});

test('无可选 debug 时仍可回显并幂等释放 DOM 和监听', async () => {
  const host = fixture();
  const dispose = await mount(host.target, host.context);
  const [button, output] = host.target.children[0].children;
  button.click();
  await tick();
  assert.match(output.textContent, /job-1/);
  assert.equal(button.disabled, false);
  await dispose();
  await dispose();
  await host.dispose();
  assert.equal(host.target.children.length, 0);
  assert.equal(button.listeners.get('click').size, 0);
});

test('多个挂载分别登记语义节点、资源、事件并各释放一次', async () => {
  const host = fixture({ debug: true });
  const releaseA = await mount(host.target, host.context);
  const releaseB = await mount(host.target, host.context);
  const [button] = host.target.children[0].children;
  button.click();
  await tick();
  assert.equal(host.nodes.length, 2);
  assert.equal(host.resources.length, 2);
  assert.ok(host.events.some((event) => event.name === 'echo_succeeded'));
  assert.equal(host.nodes[0].updates.length, 1);
  assert.ok(!JSON.stringify(host.events).includes('独立工程回显'));
  await releaseA();
  await releaseB();
  await host.dispose();
  assert.deepEqual(host.nodes.map((item) => item.disposed), [1, 1]);
  assert.deepEqual(host.resources.map((item) => item.released), [1, 1]);
});

test('卸载期间提交只派发一次，晚到结果不写回旧界面或调试状态', async () => {
  let complete;
  let calls = 0;
  const host = fixture({ debug: true, submit: () => {
    calls++;
    return new Promise((resolve) => { complete = resolve; });
  } });
  const dispose = await mount(host.target, host.context);
  const [button, output] = host.target.children[0].children;
  button.click();
  button.click();
  const before = output.textContent;
  await dispose();
  complete({ data: { id: 'late', status: 'succeeded' }, logId: 'late-log' });
  await tick();
  assert.equal(calls, 1);
  assert.equal(output.textContent, before);
  assert.equal(host.nodes[0].updates.length, 0);
  assert.equal(host.events.filter((event) => event.name === 'echo_succeeded').length, 0);
  await host.dispose();
});

test('登记失败回滚已有节点、监听和 DOM', async () => {
  const host = fixture({ debug: true });
  host.context.debug.registerResource = () => { throw new Error('资源登记失败'); };
  await assert.rejects(mount(host.target, host.context), /资源登记失败/);
  assert.equal(host.target.children.length, 0);
  assert.equal(host.nodes[0].disposed, 1);
});

test('本地服务拒绝不合法输入与已取消的调用', async () => {
  const host = fixture();
  const signal = new AbortController().signal;
  assert.deepEqual(await localEcho({ message: '你好' }, host.context, signal), {
    data: { message: '你好', source: plugin.id }, logId: null,
  });
  for (const value of [null, [], { message: 1 }, { message: 'x', extra: true }, { message: '😀'.repeat(1001) }])
    await assert.rejects(localEcho(value, host.context, signal));
  await assert.rejects(localEcho({ message: 'x' }, host.context, AbortSignal.abort()));
});

test('服务器命令只轮询同一个原 Job，保留提交和查询日志', async () => {
  let calls = 0;
  let reads = 0;
  const host = fixture({
    submit: async (operation, input, signal) => {
      calls++;
      assert.equal(operation, 'plugin.demo_debugger_server.echo');
      assert.deepEqual(input, { message: 'x' });
      assert.ok(signal instanceof AbortSignal);
      return { data: { id: 'original', status: 'queued' }, logId: 'submission' };
    },
    getJob: async (id) => {
      reads++;
      assert.equal(id, 'original');
      return { data: { id, status: 'succeeded', result: { message: 'x' } }, logId: 'query' };
    },
  });
  const result = await serverEcho({ message: 'x' }, host.context, new AbortController().signal);
  assert.equal(result.data.job.id, 'original');
  assert.equal(result.data.query_log_id, 'query');
  assert.equal(result.logId, 'submission');
  assert.equal(calls, 1);
  assert.equal(reads, 1);
});

test('查询失败不重放提交，业务失败保留原 Job 和真实日志 ID', async () => {
  let calls = 0;
  const host = fixture({
    submit: async () => { calls++; return { data: { id: 'original', status: 'running' }, logId: 'submission' }; },
    getJob: async () => { throw new Error('查询失败'); },
  });
  await assert.rejects(serverEcho({ message: 'x' }, host.context, new AbortController().signal), /查询失败/);
  assert.equal(calls, 1);
  host.context.getJob = async () => ({ data: { id: 'original', status: 'failed' }, logId: 'failure-query' });
  await assert.rejects(serverEcho({ message: 'x' }, host.context, new AbortController().signal), (error) =>
    error.jobId === 'original' && error.logId === 'failure-query');
  assert.equal(calls, 2);
});
