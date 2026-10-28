import assert from 'node:assert/strict';
import test from 'node:test';
import { isDebuggerBatch, isDebuggerTarget } from '../src/services/api/index.ts';

const target = { target_kind: 'browser', instance_id: 'instance', plugin_id: 'example', generation: '1', version: null };
test('调试响应守卫核对精确目标和必须的可空字段，不接受伪空代次', () => {
  assert.ok(isDebuggerTarget(target));
  assert.ok(isDebuggerTarget({ ...target, target_kind: 'server', instance_id: null }));
  assert.equal(isDebuggerTarget({ ...target, generation: null }), false);
  assert.equal(isDebuggerTarget({ ...target, version: undefined }), false);
  assert.equal(isDebuggerTarget({ ...target, target_kind: 'server' }), false);
  assert.equal(isDebuggerTarget({ ...target, instance_id: null }), false);
});

test('调试批次守卫拒绝越界命令、未知工具与非JSON参数', () => {
  const command = { command_id: 'command', session_id: 'session', target, tool: 'inspect', parameters: {}, remaining_ms: 5000 };
  const batch = { instance_id: 'instance', active_sessions: [], targets: [target], commands: [command] };
  assert.ok(isDebuggerBatch(batch));
  assert.equal(isDebuggerBatch({ ...batch, commands: Array(5).fill(command) }), false);
  assert.equal(isDebuggerBatch({ ...batch, commands: [{ ...command, tool: 'eval' }] }), false);
  assert.equal(isDebuggerBatch({ ...batch, commands: [{ ...command, parameters: { nested: NaN } }] }), false);
  assert.equal(isDebuggerBatch({ ...batch, commands: [{ ...command, remaining_ms: 10001 }] }), false);
  assert.ok(isDebuggerBatch({ ...batch, commands: [{ ...command, tool: 'reload', remaining_ms: 30000 }] }));
  assert.equal(isDebuggerBatch({ ...batch, commands: [{ ...command, tool: 'reload', remaining_ms: 30001 }] }), false);
});
