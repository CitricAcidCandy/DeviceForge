import assert from 'node:assert/strict';
import test from 'node:test';
import { createAutomation } from '../src/features/automation/index.ts';
import type { AutomationSequence } from '../src/features/automation/index.ts';
import { ApiError } from '../src/services/api/index.ts';
import type { JobGateway, JsonData } from '../src/shared/jobs/index.ts';
import { signal } from './fixtures.ts';

const sequence: AutomationSequence = { device_id: 'emulator-5554', steps: [{ at_ms: 0, action: { kind: 'tap', x: 4, y: 5 } }, { at_ms: 10, action: { kind: 'text', text: 'hello world' } }] };
function gateway(respond: (operation: string, input: JsonData) => JsonData): JobGateway {
  return { submit: async (operation, input) => ({ data: { id: 'automation-job', operation, status: 'succeeded', error: null, result: { result: respond(operation, input), artifacts: [] } }, logId: 'automation-log' }),
    getJob: async () => { throw new Error('终态不应查询'); }, cancelJob: async () => { throw new Error('未授权取消'); } };
}
test('自动化两操作保留原时间和数量，不宣称真实界面效果', async () => {
  const seen: { operation: string; input: JsonData }[] = [];
  const automation = createAutomation(gateway((operation, input) => { seen.push({ operation, input }); return { device_id: 'emulator-5554', dispatched: 2, completed: true, effect_confirmed: false }; }));
  const result = await automation.runSequence(sequence, signal()); assert.equal(result.data.effect_confirmed, false);
  await automation.repeatClick({ device_id: 'emulator-5554', x: 4, y: 5, count: 2, interval_ms: 10 }, signal());
  assert.deepEqual(seen[0]?.input, sequence); assert.equal(seen[0]?.operation, 'plugin.automation.sequence.run'); assert.equal(seen[1]?.operation, 'plugin.automation.click.repeat'); automation.dispose();
});
test('拒绝逆序时间、超总长、自由命令与扩展字段', () => {
  const automation = createAutomation(gateway(() => ({})));
  const reverse: AutomationSequence = { ...sequence, steps: [{ at_ms: 10, action: { kind: 'key', code: 3 } }, { at_ms: 9, action: { kind: 'tap', x: 0, y: 0 } }] };
  assert.throws(() => automation.runSequence(reverse, signal()), ApiError);
  assert.throws(() => automation.repeatClick({ device_id: 'demo', x: 0, y: 0, count: 10000, interval_ms: 60000 }, signal()), ApiError);
  const shell: AutomationSequence = { ...sequence, steps: [{ at_ms: 0, action: { kind: 'text', text: 'hi;reboot' } }] };
  assert.throws(() => automation.runSequence(shell, signal()), ApiError);
  const extra = { ...sequence, command: 'shell' }; assert.throws(() => automation.runSequence(extra, signal()), ApiError); automation.dispose();
});
test('不接受局部完成、错设备或已确认效果', async () => {
  for (const value of [{ device_id: 'demo', dispatched: 2, completed: true, effect_confirmed: false }, { device_id: 'emulator-5554', dispatched: 1, completed: true, effect_confirmed: false }, { device_id: 'emulator-5554', dispatched: 2, completed: true, effect_confirmed: true }]) {
    const automation = createAutomation(gateway(() => value));
    await assert.rejects(automation.runSequence(sequence, signal()), (error: unknown) => error instanceof ApiError && error.logId === 'automation-log'); automation.dispose();
  }
});
