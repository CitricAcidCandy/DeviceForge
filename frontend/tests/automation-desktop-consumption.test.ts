import assert from 'node:assert/strict';
import test from 'node:test';
import { createAutomation } from '../src/features/automation/index.ts';
import { ApiError } from '../src/shared/api/index.ts';
import type { JobGateway, JsonData } from '../src/shared/jobs/index.ts';
import { signal } from './fixtures.ts';

function envelope(result: JsonData, names: readonly string[] = []): JsonData {
  return { result, artifacts: names.map((filename) => ({ id: `trace-${filename}`, filename, size: 0, sha256: 'a'.repeat(64), media_type: 'application/octet-stream', created_at: 1 })) };
}
function gateway(respond: (operation: string, input: JsonData) => JsonData): JobGateway {
  return { submit: async (operation, input) => ({ data: { id: 'desktop-job', operation, status: 'succeeded', result: respond(operation, input), error: null }, logId: 'desktop-log' }),
    getJob: async () => { throw new Error('终态不应查询'); }, cancelJob: async () => { throw new Error('未授权取消'); } };
}

test('Windows鼠标三个贡献消费负桌面坐标、双击和F9真实停止', async () => {
  const seen: { operation: string; input: JsonData }[] = [];
  const automation = createAutomation(gateway((operation, input) => {
    seen.push({ operation, input });
    if (operation.endsWith('.position')) return envelope({ x: -1920, y: 100, coordinate_space: 'virtual_desktop', source: 'GetCursorPos' });
    if (operation.endsWith('.click')) return envelope({ dispatched: 1, button: 'right', click: 'double', position: { x: -20, y: 100 }, effect_confirmed: false });
    return envelope({ dispatched: 3, button: 'left', click: 'single', position: { x: 10, y: 20 }, elapsed_ms: 40, stop_reason: 'f9', effect_confirmed: false });
  }));
  assert.equal((await automation.mousePosition(signal())).data.x, -1920);
  assert.equal((await automation.clickMouse({ button: 'right', click: 'double', position: { x: -20, y: 100 } }, signal())).data.dispatched, 1);
  assert.equal((await automation.repeatMouse({ button: 'left', click: 'single', interval_ms: 10, repeat: { kind: 'manual', max_duration_ms: 1000 } }, signal())).data.stop_reason, 'f9');
  assert.deepEqual(seen[1]?.input, { button: 'right', click: 'double', position: { x: -20, y: 100 } }); assert.equal(seen.length, 3); automation.dispose();
});

test('Windows参数有界，次数停止与禁用F9的结果须对应输入', async () => {
  const automation = createAutomation(gateway(() => envelope({ dispatched: 2, button: 'left', click: 'single', position: { x: 10, y: 20 }, elapsed_ms: 20, stop_reason: 'count_limit', effect_confirmed: false })));
  assert.throws(() => automation.clickMouse({ button: 'left', click: 'single', position: { x: 2147483648, y: 0 } }, signal()), ApiError);
  assert.throws(() => automation.repeatMouse({ button: 'left', click: 'single', interval_ms: 10, repeat: { kind: 'manual', max_duration_ms: 0 } }, signal()), ApiError);
  await assert.rejects(automation.repeatMouse({ button: 'left', click: 'single', interval_ms: 10, repeat: { kind: 'count', count: 3 } }, signal()), (error: unknown) => error instanceof ApiError && error.logId === 'desktop-log'); automation.dispose();
  const f9 = createAutomation(gateway(() => envelope({ dispatched: 0, button: 'left', click: 'single', position: { x: 10, y: 20 }, elapsed_ms: 20, stop_reason: 'f9', effect_confirmed: false })));
  await assert.rejects(f9.repeatMouse({ button: 'left', click: 'single', interval_ms: 10, repeat: { kind: 'duration', duration_ms: 100 }, stop_on_f9: false }, signal()), ApiError); f9.dispose();
});

test('未指定位置使用实际指针观测，有界手动停止保留manual_limit', async () => {
  const automation = createAutomation(gateway((operation) => operation.endsWith('.click')
    ? envelope({ dispatched: 1, button: 'middle', click: 'single', position: { x: -400, y: 80 }, effect_confirmed: false })
    : envelope({ dispatched: 10, button: 'left', click: 'single', position: { x: -400, y: 80 }, elapsed_ms: 100, stop_reason: 'manual_limit', effect_confirmed: false })));
  assert.deepEqual((await automation.clickMouse({ button: 'middle', click: 'single' }, signal())).data.position, { x: -400, y: 80 });
  assert.equal((await automation.repeatMouse({ button: 'left', click: 'single', interval_ms: 10, repeat: { kind: 'manual', max_duration_ms: 100 } }, signal())).data.stop_reason, 'manual_limit');
  assert.throws(() => automation.repeatMouse({ button: 'left', click: 'single', interval_ms: 60000, repeat: { kind: 'count', count: 12 } }, signal()), ApiError); automation.dispose();
});

test('输入轨迹录制和回放保留MessagePack产物、筛选类型及正常结束', async () => {
  const seen: { operation: string; input: JsonData }[] = [];
  const automation = createAutomation(gateway((operation, input) => {
    seen.push({ operation, input });
    return operation.endsWith('.record')
      ? envelope({ recorded: true, event_type: 0, duration_ms: 100, events: 2, stop: 'stdin_exit', format: 'input_trace.msgpack.v1', effect_confirmed: false }, ['recording.msgpack', 'operation.json', 'input-trace.log'])
      : envelope({ completed: true, event_type: 2, events: 1, format: 'input_trace.msgpack.v1', effect_confirmed: false }, ['operation.json', 'input-trace.log']);
  }));
  const recorded = await automation.recordInputTrace({ event_type: 0, interval_ms: 2, duration_ms: 100 }, signal());
  assert.equal(recorded.data.result.stop, 'stdin_exit'); assert.equal(recorded.data.artifacts[0]?.filename, 'recording.msgpack');
  await automation.playbackInputTrace({ artifact_id: 'trace-recording.msgpack', event_type: 2 }, signal());
  assert.deepEqual(seen[1]?.input, { artifact_id: 'trace-recording.msgpack', event_type: 2 });
  assert.throws(() => automation.recordInputTrace({ event_type: 0, interval_ms: 1, duration_ms: 100 }, signal()), ApiError);
  assert.throws(() => automation.downloadTrace(recorded.data, 'recording.msgpack', signal()), (error: unknown) => error instanceof ApiError && error.code === 'artifact_access_unavailable'); automation.dispose();
});

test('强杀录制不作成功，缺产物及错事件类型拒绝', async () => {
  const killed = createAutomation(gateway(() => envelope({ recorded: true, event_type: 0, duration_ms: 100, events: 2, stop: 'killed', format: 'input_trace.msgpack.v1', effect_confirmed: false }, ['recording.msgpack', 'operation.json', 'input-trace.log'])));
  await assert.rejects(killed.recordInputTrace({ event_type: 0, interval_ms: 2, duration_ms: 100 }, signal()), ApiError); killed.dispose();
  const playback = createAutomation(gateway(() => envelope({ completed: true, event_type: 1, events: 1, format: 'input_trace.msgpack.v1', effect_confirmed: false }, ['operation.json'])));
  await assert.rejects(playback.playbackInputTrace({ artifact_id: 'recording', event_type: 2 }, signal()), ApiError); playback.dispose();
});
