import assert from 'node:assert/strict';
import test from 'node:test';
import { convertLegacyMouse, createAutomation } from '../src/features/automation/index.ts';
import { ApiError } from '../src/shared/api/index.ts';
import type { JobGateway, JsonData } from '../src/shared/jobs/index.ts';
import { signal } from './fixtures.ts';

const base = { mouseButtonType: 0, clickType: 0, clickPosType: 0, clickCountType: 0,
  repeatedType: 1, repeatedClickCount: 3 };
const invalid = (error: unknown): boolean => error instanceof ApiError && error.code === 'invalid_legacy_mouse';

test('旧按钮、单双击和三个速度档位精确映射', () => {
  for (const [mouseButtonType, button] of [[0, 'left'], [1, 'middle'], [2, 'right']]) {
    for (const [clickCountType, interval] of [[0, 100], [1, 10], [2, 125]]) {
      const result = convertLegacyMouse({ ...base, mouseButtonType, clickCountType, timeInterval: 125, clickType: 1 });
      assert.equal(result.button, button); assert.equal(result.click, 'double');
      assert.equal(result.interval_ms, interval); assert.equal(result.stop_on_f9, true);
    }
  }
  assert.equal(convertLegacyMouse(base).click, 'single');
});

test('当前位置不输出坐标，IPC与表单自定义位置均保留负坐标', () => {
  assert.equal(Object.hasOwn(convertLegacyMouse({ ...base, clickPosX: 0, clickPosY: 0 }), 'position'), false);
  for (const coordinates of [{ clickPos: { x: -1920, y: 2147483647 } }, { clickPosX: -1920, clickPosY: 2147483647 }]) {
    assert.deepEqual(convertLegacyMouse({ ...base, clickPosType: 1, ...coordinates }).position, { x: -1920, y: 2147483647 });
  }
  assert.deepEqual(convertLegacyMouse({ ...base, clickPosType: 1, clickPos: { x: -2147483648, y: 0 } }).position,
    { x: -2147483648, y: 0 });
});

test('秒精确转换毫秒，不减一秒、不取整或原地修改', () => {
  for (const seconds of [0.1, 0.125, 1, 1.001, 1.5, 600]) {
    const input = Object.freeze({ ...base, repeatedType: 2, repeatedClickDuration: seconds,
      clickPosType: 1, clickPos: Object.freeze({ x: -10, y: 20 }) });
    const result = convertLegacyMouse(input);
    assert.deepEqual(result.repeat, { kind: 'duration', duration_ms: Math.round(seconds * 1000) });
    assert.equal(input.repeatedClickDuration, seconds); assert.notEqual(result.position, input.clickPos);
  }
  for (const seconds of [0, 0.099, 0.1001, 600.001, NaN, Infinity, '1']) {
    assert.throws(() => convertLegacyMouse({ ...base, repeatedType: 2, repeatedClickDuration: seconds }), invalid);
  }
});

test('手动停止要求显式有限上限并开启F9', () => {
  const input = { ...base, repeatedType: 0 };
  assert.throws(() => convertLegacyMouse(input), invalid);
  for (const maximum of [100, 600000]) {
    assert.deepEqual(convertLegacyMouse(input, { manualMaxDurationMs: maximum }).repeat,
      { kind: 'manual', max_duration_ms: maximum });
  }
  for (const maximum of [0, 99, 600001, 100.5, NaN, Infinity]) {
    assert.throws(() => convertLegacyMouse(input, { manualMaxDurationMs: maximum }), invalid);
  }
  assert.throws(() => convertLegacyMouse(base, { manualMaxDurationMs: 100 }), invalid);
});

test('非活动字段允许旧零占位，自定义间隔与活动停止条件仍拒绝零', () => {
  for (const clickCountType of [0, 1]) {
    const result = convertLegacyMouse({ ...base, clickCountType, timeInterval: 0, repeatedClickDuration: 0 });
    assert.equal(result.interval_ms, clickCountType === 0 ? 100 : 10);
    assert.deepEqual(convertLegacyMouse({ ...base, clickCountType, timeInterval: 0, repeatedType: 2,
      repeatedClickCount: 0, repeatedClickDuration: 1 }).repeat, { kind: 'duration', duration_ms: 1000 });
  }
  assert.throws(() => convertLegacyMouse({ ...base, clickCountType: 2, timeInterval: 0 }), invalid);
  assert.throws(() => convertLegacyMouse({ ...base, repeatedClickCount: 0 }), invalid);
  assert.throws(() => convertLegacyMouse({ ...base, repeatedType: 2, repeatedClickDuration: 0 }), invalid);
});

test('次数、间隔和总调度限额沿用现有规则，不钳制', () => {
  assert.equal(convertLegacyMouse({ ...base, repeatedClickCount: 1 }).interval_ms, 100);
  assert.deepEqual(convertLegacyMouse({ ...base, clickCountType: 2, timeInterval: 60000, repeatedClickCount: 11 }).repeat,
    { kind: 'count', count: 11 });
  assert.equal(convertLegacyMouse({ ...base, clickCountType: 1, repeatedClickCount: 10000 }).interval_ms, 10);
  for (const input of [{ ...base, repeatedClickCount: 0 }, { ...base, repeatedClickCount: 10001 },
    { ...base, repeatedClickCount: 1.5 }, { ...base, repeatedClickCount: '3' },
    { ...base, clickCountType: 2 }, { ...base, clickCountType: 2, timeInterval: 9 },
    { ...base, clickCountType: 2, timeInterval: 60001 }, { ...base, clickCountType: 2, timeInterval: 10.5 },
    { ...base, clickCountType: 2, timeInterval: '100' },
    { ...base, clickCountType: 2, timeInterval: 60000, repeatedClickCount: 12 }]) {
    assert.throws(() => convertLegacyMouse(input), invalid);
  }
});

test('未知字段、枚举、歧义坐标和缺半对坐标拒绝', () => {
  for (const input of [null, [], { ...base, unknown: true }, { ...base, mouseButtonType: 3 },
    { ...base, clickType: -1 }, { ...base, clickPosType: 2 }, { ...base, clickCountType: 3 },
    { ...base, repeatedType: 3 }, { ...base, mouseButtonType: '0' },
    { ...base, clickPosType: 1 }, { ...base, clickPosType: 1, clickPosX: 1 },
    { ...base, clickPosType: 1, clickPos: { x: 0, y: 0 }, clickPosX: 0, clickPosY: 0 },
    { ...base, clickPosType: 1, clickPos: { x: 0, y: 0, z: 0 } },
    { ...base, clickPosType: 1, clickPos: { x: '1', y: 0 } },
    { ...base, clickPosType: 1, clickPos: { x: 2147483648, y: 0 } },
    { ...base, clickPosType: 1, clickPos: { x: 1.5, y: 0 } }]) {
    assert.throws(() => convertLegacyMouse(input), invalid);
  }
});

test('纯转换零提交，显式执行成功仅提交一次并保留日志ID', async () => {
  const submissions: { operation: string; input: JsonData }[] = [];
  const gateway: JobGateway = {
    submit: async (operation, input) => {
      submissions.push({ operation, input });
      return { data: { id: 'legacy-mouse-job', operation, status: 'succeeded', error: null,
        result: { result: { dispatched: 3, stop_reason: 'count_limit', button: 'left', click: 'single',
          position: { x: -10, y: 20 }, elapsed_ms: 200, effect_confirmed: false }, artifacts: [] } }, logId: 'legacy-mouse-log' };
    },
    getJob: async () => { throw new Error('终态任务不应额外查询'); },
    cancelJob: async () => { throw new Error('不应隐式取消'); },
  };
  const automation = createAutomation(gateway);
  assert.throws(() => convertLegacyMouse({ ...base, repeatedClickCount: 0 }), invalid);
  const converted = convertLegacyMouse(base);
  assert.equal(submissions.length, 0);
  const outcome = await automation.repeatMouse(converted, signal());
  assert.equal(outcome.logId, 'legacy-mouse-log'); assert.equal(submissions.length, 1);
  assert.deepEqual(submissions[0], { operation: 'plugin.automation.windows.mouse.repeat', input: converted });
  automation.dispose();
});
