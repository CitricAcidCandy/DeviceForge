import test from 'node:test';
import assert from 'node:assert/strict';
import { debuggerRequest, debuggerTool, confirmedResponse, snapshotPage } from '../browser/src/debugger-client.js';

const signal = () => new AbortController().signal;

test('只消费 host.debugger 精确版本并保留请求、信号和日志 ID', async () => {
  const request = { action: 'reconnect', input: { confirmed: true } };
  let calls = 0;
  const context = { signal: signal(), extensions: { async callService(id, version, input, active) {
    calls++;
    assert.equal(id, 'host.debugger');
    assert.equal(version, '1');
    assert.equal(input, request);
    assert.ok(active instanceof AbortSignal);
    return { data: { instance_id: 'current' }, logId: 'real-log' };
  } } };
  const response = await debuggerRequest(context, request, signal());
  assert.equal(response.logId, 'real-log');
  assert.equal(calls, 1);
});

test('缺服务和已取消调用明确失败且不派发', async () => {
  await assert.rejects(debuggerRequest({ signal: signal() }, { action: 'status' }, signal()), /公开扩展服务/);
  const context = { signal: signal(), extensions: { callService() { assert.fail('不应派发'); } } };
  await assert.rejects(debuggerRequest(context, { action: 'start' }, AbortSignal.abort()));
});

test('快照续页走 ui_tree 并保留冻结快照身份', async () => {
  const calls = [];
  const context = { signal: signal(), extensions: { async callService(id, version, input) {
    calls.push(input);
    return { data: {}, logId: null };
  } } };
  await snapshotPage(context, 'session-1', { root_id: 'root-1', snapshot_id: 'snapshot-1', offset: 500 }, signal());
  assert.deepEqual(calls, [{ action: 'call', name: 'deviceforge.debug_ui_tree', input: {
    session_id: 'session-1', parameters: { root_id: 'root-1', snapshot_id: 'snapshot-1', offset: 500, limit: 500 },
  } }]);
  await debuggerTool(context, 'deviceforge.debug_report', { session_id: 'session-1', parameters: { export: 'none' } }, signal());
  assert.equal(calls[1].input.parameters.export, 'none');
});

test('仅成功回执解包，未知结果保留日志并拒绝自动重放', () => {
  assert.deepEqual(confirmedResponse({ data: { report: {}, artifact: null }, logId: 'log' }), { report: {}, artifact: null });
  assert.deepEqual(confirmedResponse({ data: { command_id: 'c1', state: 'succeeded', response: { tree: {} } }, logId: null }), { tree: {} });
  for (const state of ['queued', 'delivered', 'failed', 'timed_out_unconfirmed', 'cancelled_unconfirmed']) {
    assert.throws(() => confirmedResponse({ data: { command_id: 'c1', state }, logId: 'unknown-log' }),
      (error) => error.logId === 'unknown-log' && error.message.includes(state));
  }
});
