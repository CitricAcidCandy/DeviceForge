import assert from 'node:assert/strict';
import test from 'node:test';
import { createAutomation, createHttpAutomation } from '../src/features/automation/index.ts';
import type { AutomationOperation, AutomationSequence, DesktopClick, DesktopRepeat, InputTracePlayback, InputTraceRecord } from '../src/features/automation/index.ts';
import { ApiError, createApiClient } from '../src/shared/api/index.ts';
import type { ArtifactDto, OperationDto } from '../src/shared/api/index.ts';
import type { JobGateway, JobTicket, JsonData, TaskRecord } from '../src/shared/jobs/index.ts';
import { JobWaitFailure } from '../src/shared/jobs/index.ts';
import { requireRepeat, requireSequence } from '../src/features/automation/rules.ts';
import { requireDesktopClick, requireInputTrace } from '../src/features/automation/desktop-rules.ts';
import { decodeAutomationResult } from '../src/features/automation/results.ts';
import { decodeDesktopClick, decodeDesktopPosition, decodeDesktopRepeat, decodeInputTracePlayback, decodeInputTraceRecord } from '../src/features/automation/desktop-results.ts';
import { deferred, requestUrl, signal, success } from './fixtures.ts';

const actions: readonly AutomationOperation[] = ['sequence.run', 'click.repeat', 'windows.mouse.position', 'windows.mouse.click', 'windows.mouse.repeat', 'input_trace.record', 'input_trace.playback'];
const operation = (action: AutomationOperation) => `plugin.automation.${action}`;
const sequence = { device_id: 'emulator-5554', steps: [
  { at_ms: 0, action: { kind: 'tap', x: 0, y: 65535 } },
  { at_ms: 10, action: { kind: 'swipe', x1: 0, y1: 1, x2: 2, y2: 3, duration_ms: 10 } },
  { at_ms: 10, action: { kind: 'key', code: 288 } },
  { at_ms: 100, action: { kind: 'text', text: 'hello world' } },
] } satisfies AutomationSequence;
const repeated = { device_id: sequence.device_id, x: 4, y: 5, count: 2, interval_ms: 10 };
const click = { button: 'right', click: 'double', position: { x: -20, y: 100 } } satisfies DesktopClick;
const mouse = { button: 'left', click: 'single', interval_ms: 10, repeat: { kind: 'count', count: 3 }, stop_on_f9: false } satisfies DesktopRepeat;
const record = { event_type: 0, interval_ms: 2, duration_ms: 100 } satisfies InputTraceRecord;
const playback = { artifact_id: 'trace-recording.msgpack', event_type: 2 } satisfies InputTracePlayback;
function definitions(): OperationDto[] { return actions.map((action) => ({ id: operation(action), title: action, input_schema: { type: 'object' } })); }
function metadata(filename: string, changes: Partial<ArtifactDto> = {}): ArtifactDto {
  return { id: `trace-${filename}`, filename, size: 1, sha256: 'a'.repeat(64), media_type: 'application/octet-stream', created_at: 1, ...changes };
}
function result(action: AutomationOperation): Record<string, unknown> {
  switch (action) {
    case 'sequence.run': return { device_id: sequence.device_id, dispatched: sequence.steps.length, completed: true, effect_confirmed: false };
    case 'click.repeat': return { device_id: sequence.device_id, dispatched: repeated.count, completed: true, effect_confirmed: false };
    case 'windows.mouse.position': return { x: -1920, y: 100, coordinate_space: 'virtual_desktop', source: 'GetCursorPos' };
    case 'windows.mouse.click': return { dispatched: 1, button: click.button, click: click.click, position: { x: -25, y: 100 }, effect_confirmed: false };
    case 'windows.mouse.repeat': return { dispatched: 3, button: mouse.button, click: mouse.click, position: { x: -400, y: 80 }, elapsed_ms: 25, stop_reason: 'count_limit', effect_confirmed: false };
    case 'input_trace.record': return { recorded: true, event_type: record.event_type, duration_ms: record.duration_ms, events: 2, stop: 'stdin_exit', format: 'input_trace.msgpack.v1', effect_confirmed: false };
    case 'input_trace.playback': return { completed: true, event_type: playback.event_type, events: 1, format: 'input_trace.msgpack.v1', effect_confirmed: false };
  }
}
function envelope(action: AutomationOperation, value: unknown = result(action)) {
  const names = action === 'input_trace.record' ? ['recording.msgpack', 'operation.json', 'input-trace.log'] : action === 'input_trace.playback' ? ['operation.json', 'input-trace.log'] : [];
  return { result: value, artifacts: names.map((filename) => metadata(filename)) };
}
function input(action: AutomationOperation): JsonData {
  switch (action) {
    case 'sequence.run': return sequence;
    case 'click.repeat': return repeated;
    case 'windows.mouse.position': return {};
    case 'windows.mouse.click': return click;
    case 'windows.mouse.repeat': return mouse;
    case 'input_trace.record': return record;
    case 'input_trace.playback': return playback;
  }
}
function gateway(action: AutomationOperation = 'sequence.run', changes: Partial<JobGateway> = {}): JobGateway {
  return {
    submit: async (id) => ({ data: { id: 'automation-job', operation: id, status: 'succeeded', result: envelope(action) }, logId: 'submit-log' }),
    getJob: async () => ({ data: { id: 'automation-job', operation: operation(action), status: 'succeeded', result: envelope(action) }, logId: 'query-log' }),
    cancelJob: async () => ({ data: { id: 'automation-job', operation: operation(action), status: 'cancelled' }, logId: 'cancel-log' }),
    ...changes,
  };
}
type Automation = ReturnType<typeof createAutomation>;
interface Invocation {
  readonly action: AutomationOperation;
  readonly start: (automation: Automation, signal: AbortSignal) => Promise<{ readonly submitLogId: string | null; readonly logId: string | null }>;
  readonly resume: (automation: Automation, ticket: JobTicket, signal: AbortSignal) => Promise<{ readonly submitLogId: string | null; readonly logId: string | null }>;
}
const invocations: readonly Invocation[] = [
  { action: 'sequence.run', start: (automation, signal) => automation.runSequence(sequence, signal), resume: (automation, ticket, signal) => automation.resumeSequence(ticket, sequence, signal) },
  { action: 'click.repeat', start: (automation, signal) => automation.repeatClick(repeated, signal), resume: (automation, ticket, signal) => automation.resumeRepeat(ticket, repeated, signal) },
  { action: 'windows.mouse.position', start: (automation, signal) => automation.mousePosition(signal), resume: (automation, ticket, signal) => automation.resumeMousePosition(ticket, signal) },
  { action: 'windows.mouse.click', start: (automation, signal) => automation.clickMouse(click, signal), resume: (automation, ticket, signal) => automation.resumeMouseClick(ticket, click, signal) },
  { action: 'windows.mouse.repeat', start: (automation, signal) => automation.repeatMouse(mouse, signal), resume: (automation, ticket, signal) => automation.resumeMouseRepeat(ticket, mouse, signal) },
  { action: 'input_trace.record', start: (automation, signal) => automation.recordInputTrace(record, signal), resume: (automation, ticket, signal) => automation.resumeInputTraceRecord(ticket, record, signal) },
  { action: 'input_trace.playback', start: (automation, signal) => automation.playbackInputTrace(playback, signal), resume: (automation, ticket, signal) => automation.resumeInputTracePlayback(ticket, playback, signal) },
];

test('真实HTTP目录仅接纳七项贡献，设备、桌面及轨迹按实际平铺输入消费', async () => {
  const calls: { path: string; body: unknown }[] = [];
  const client = createApiClient({ baseUrl: 'http://localhost:3000', transport: async (request, init) => {
    const url = requestUrl(request); const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ path: url.pathname, body });
    if (url.pathname.endsWith('/operations')) return success([...definitions(), { id: 'plugin.automation.sequence.run.extra', title: '无关贡献', input_schema: {} }], 'catalog-log');
    if (typeof body === 'object' && body !== null && 'operation' in body && typeof body.operation === 'string') {
      const action = actions.find((action) => operation(action) === body.operation);
      if (action) return success({ id: 'automation-job', operation: body.operation, input: 'input' in body ? body.input : {}, created_at: 1, status: 'succeeded', result: envelope(action) }, 'task-log');
    }
    throw new Error('未声明HTTP请求');
  } });
  const automation = createHttpAutomation(client, { pollIntervalMs: 0 });
  for (const invocation of invocations) assert.throws(() => invocation.start(automation, signal()), ApiError);
  await automation.refreshOperations(signal());
  const outcomes = [];
  for (const invocation of invocations) outcomes.push(await invocation.start(automation, signal()));
  assert.deepEqual(calls.slice(1).map((call) => call.body), actions.map((action) => ({ operation: operation(action), input: input(action) })));
  assert.ok(outcomes.every((outcome) => outcome.submitLogId === 'task-log' && outcome.logId === 'task-log'));
  assert.equal(automation.snapshot().operations.length, 7); assert.equal(automation.snapshot().logId, 'catalog-log');
  assert.ok(Object.isFrozen(automation.snapshot().operations[0]?.input_schema)); automation.dispose();
});

test('七项操作取消等待都恢复原票据，目录失效后不重提或自动取消服务器', async () => {
  for (const invocation of invocations) {
    let submissions = 0; let cancels = 0; let failed = false;
    const automation = createAutomation(gateway(invocation.action, {
      submit: async (id) => { submissions++; return { data: { id: 'automation-job', operation: id, status: 'running' }, logId: 'submit-log' }; },
      cancelJob: async () => { cancels++; return { data: { id: 'automation-job', operation: operation(invocation.action), status: 'cancelled' }, logId: 'explicit-cancel-log' }; },
    }), { pollIntervalMs: 10000, operations: { list: async () => {
      if (failed) throw new ApiError('http', 'plugin_unavailable', '自动化插件不可用', 503, 'catalog-error-log');
      return { data: definitions(), logId: 'catalog-log' };
    } } });
    await automation.refreshOperations(signal());
    const controller = new AbortController(); const waiting = invocation.start(automation, controller.signal);
    await new Promise((resolve) => setImmediate(resolve)); controller.abort();
    await assert.rejects(waiting, (error: unknown) => error instanceof JobWaitFailure && error.job.id === 'automation-job'
      && error.job.operation === operation(invocation.action) && error.submitLogId === 'submit-log' && error.lastKnownLogId === 'submit-log');
    failed = true; await assert.rejects(automation.refreshOperations(signal()), (error: unknown) => error instanceof ApiError && error.logId === 'catalog-error-log');
    assert.throws(() => invocation.start(automation, signal()), ApiError);
    const ticket = { id: 'automation-job', operation: operation(invocation.action), submitLogId: 'submit-log' };
    assert.equal((await automation.queryJob(ticket, signal())).logId, 'query-log');
    const resumed = await invocation.resume(automation, ticket, signal());
    assert.equal(resumed.submitLogId, 'submit-log'); assert.equal(resumed.logId, 'query-log'); assert.equal(submissions, 1); assert.equal(cancels, 0);
    assert.equal((await automation.cancel(ticket, signal())).logId, 'explicit-cancel-log'); assert.equal(cancels, 1); automation.dispose();
  }
});

test('设备序列和桌面嵌套配置使用冻结副本，调用者修改不改变提交及回显预期', async () => {
  const submitted: JsonData[] = []; const waiting = deferred<{ data: TaskRecord; logId: string }>();
  const automation = createAutomation(gateway('sequence.run', { submit: async (_operation, value) => { submitted.push(value); return waiting.promise; } }));
  const original = structuredClone(sequence); const pending = automation.runSequence(original, signal());
  original.device_id = 'other-device'; original.steps.pop();
  assert.deepEqual(submitted, [sequence]); assert.ok(Object.isFrozen(submitted[0]));
  waiting.resolve({ data: { id: 'automation-job', operation: operation('sequence.run'), status: 'succeeded', result: envelope('sequence.run') }, logId: 'copy-log' });
  assert.equal((await pending).data.dispatched, sequence.steps.length); automation.dispose();
  const desktopSubmitted: JsonData[] = []; const desktopWaiting = deferred<{ data: TaskRecord; logId: string }>();
  const desktop = createAutomation(gateway('windows.mouse.repeat', { submit: async (_operation, value) => { desktopSubmitted.push(value); return desktopWaiting.promise; } }));
  const originalMouse = { ...mouse, repeat: { ...mouse.repeat }, position: { x: -20, y: 100 } };
  const repeating = desktop.repeatMouse(originalMouse, signal());
  originalMouse.repeat.count = 2; originalMouse.position.x = 999;
  assert.deepEqual(desktopSubmitted, [{ ...mouse, position: { x: -20, y: 100 } }]);
  const submittedMouse = desktopSubmitted[0];
  assert.ok(Object.isFrozen(submittedMouse));
  if (typeof submittedMouse === 'object' && submittedMouse !== null && !Array.isArray(submittedMouse)) {
    assert.ok(Object.isFrozen(submittedMouse.repeat)); assert.ok(Object.isFrozen(submittedMouse.position));
  }
  desktopWaiting.resolve({ data: { id: 'automation-job', operation: operation('windows.mouse.repeat'), status: 'succeeded', result: envelope('windows.mouse.repeat') }, logId: 'desktop-copy-log' });
  const outcome = await repeating; assert.equal(outcome.data.dispatched, 3); assert.ok(Object.isFrozen(outcome.data.position));
  assert.deepEqual(outcome.data.position, { x: -400, y: 80 }); desktop.dispose();
});

test('设备动作与桌面输入沿各自边界，回放ID按UTF8字节和有效Unicode校验', () => {
  for (const device_id of ['.device', '_device', ':5555', 'a'.repeat(200)]) requireSequence({ ...sequence, device_id });
  for (const device_id of ['', '-device', '设备', 'a'.repeat(201), 'device/other']) assert.throws(() => requireSequence({ ...sequence, device_id }), ApiError);
  requireSequence({ device_id: 'demo', steps: Array.from({ length: 10000 }, () => ({ at_ms: 3600000, action: { kind: 'tap', x: 0, y: 65535 } })) });
  requireRepeat({ ...repeated, count: 61, interval_ms: 60000 });
  for (const value of [
    { ...repeated, count: 62, interval_ms: 60000 }, { ...repeated, x: -1 }, { ...repeated, y: 65536 }, { ...repeated, count: 1.5 },
    { ...sequence, steps: [] }, { ...sequence, steps: [{ at_ms: 3600001, action: { kind: 'tap', x: 0, y: 0 } }] },
    { ...sequence, steps: [{ at_ms: 0, action: { kind: 'text', text: '文' } }] },
    { ...sequence, steps: [{ at_ms: 0, action: { kind: 'text', text: 'a'.repeat(1025) } }] },
    { ...sequence, steps: [{ at_ms: 0, action: { kind: 'swipe', x1: 0, y1: 0, x2: 0, y2: 0, duration_ms: 0 } }] },
    { ...sequence, steps: [{ at_ms: 0, action: { kind: 'key', code: 289 } }] },
  ]) assert.throws(() => 'count' in value ? requireRepeat(value) : requireSequence(value), ApiError);
  requireDesktopClick({ ...click, position: { x: -2147483648, y: 2147483647 } }, false);
  requireDesktopClick({ ...mouse, repeat: { kind: 'count', count: 11 }, interval_ms: 60000 }, true);
  for (const value of [
    { ...click, position: { x: -2147483649, y: 0 } }, { ...click, position: null }, { ...click, command: 'send' },
  ]) assert.throws(() => requireDesktopClick(value, false), ApiError);
  for (const value of [
    { ...mouse, repeat: { kind: 'count', count: 12 }, interval_ms: 60000 }, { ...mouse, stop_on_f9: null },
    { ...mouse, repeat: { kind: 'manual', max_duration_ms: 600001 } }, { ...mouse, interval_ms: 10.5 },
  ]) assert.throws(() => requireDesktopClick(value, true), ApiError);
  for (const artifact_id of ['文'.repeat(66), '😀'.repeat(50), 'opaque-id']) requireInputTrace({ ...playback, artifact_id }, true);
  for (const artifact_id of ['', '文'.repeat(67), '😀'.repeat(51), '\ud800', '\udc00', 'id\u0085']) assert.throws(() => requireInputTrace({ ...playback, artifact_id }, true), ApiError);
  for (const value of [{ ...record, interval_ms: 1 }, { ...record, duration_ms: 99 }, { ...record, event_type: 3 }, { ...record, filename: 'client.msgpack' }]) assert.throws(() => requireInputTrace(value, false), ApiError);
});

test('七项结果拒绝额外字段及虚假效果，实际指针观测与零派发F9可保留', () => {
  const decoders: { action: AutomationOperation; decode: (raw: unknown, logId: string) => unknown }[] = [
    { action: 'sequence.run', decode: (raw, logId) => decodeAutomationResult(raw, logId, sequence.device_id, sequence.steps.length) },
    { action: 'click.repeat', decode: (raw, logId) => decodeAutomationResult(raw, logId, repeated.device_id, repeated.count) },
    { action: 'windows.mouse.position', decode: decodeDesktopPosition },
    { action: 'windows.mouse.click', decode: (raw, logId) => decodeDesktopClick(raw, logId, click) },
    { action: 'windows.mouse.repeat', decode: (raw, logId) => decodeDesktopRepeat(raw, logId, mouse) },
    { action: 'input_trace.record', decode: (raw, logId) => decodeInputTraceRecord(raw, logId, record) },
    { action: 'input_trace.playback', decode: (raw, logId) => decodeInputTracePlayback(raw, logId, playback) },
  ];
  for (const entry of decoders) {
    assert.throws(() => entry.decode(envelope(entry.action, { ...result(entry.action), confirmed: true }), 'extra-field-log'), (error: unknown) => error instanceof ApiError && error.logId === 'extra-field-log');
    if (entry.action !== 'windows.mouse.position') assert.throws(() => entry.decode(envelope(entry.action, { ...result(entry.action), effect_confirmed: true }), 'false-effect-log'), ApiError);
    const output = entry.decode(envelope(entry.action), 'good-log'); assert.ok(Object.isFrozen(output));
  }
  assert.throws(() => decodeDesktopClick(envelope('windows.mouse.click', { ...result('windows.mouse.click'), position: { x: 0, y: 0, device_id: 'fake' } }), 'position-error-log', click), ApiError);
  assert.throws(() => decodeDesktopRepeat(envelope('windows.mouse.repeat', { ...result('windows.mouse.repeat'), elapsed_ms: Number.MAX_SAFE_INTEGER + 1 }), null, mouse), ApiError);
  const stopped = decodeDesktopRepeat(envelope('windows.mouse.repeat', { ...result('windows.mouse.repeat'), dispatched: 0, stop_reason: 'f9', elapsed_ms: 0 }), null, { ...mouse, stop_on_f9: true });
  assert.equal(stopped.dispatched, 0); assert.equal(stopped.effect_confirmed, false);
  assert.deepEqual(decodeDesktopClick(envelope('windows.mouse.click'), null, click).position, { x: -25, y: 100 });
});

test('轨迹结果沿固定产物和十万事件上限，不接受强杀、错回显或超大元数据', () => {
  for (const changes of [
    { events: 0 }, { events: 100001 }, { events: Number.MAX_SAFE_INTEGER + 1 }, { stop: 'killed' },
    { event_type: 2 }, { duration_ms: 101 }, { format: 'json' },
  ]) assert.throws(() => decodeInputTraceRecord(envelope('input_trace.record', { ...result('input_trace.record'), ...changes }), 'trace-result-log', record), (error: unknown) => error instanceof ApiError && error.logId === 'trace-result-log');
  const recorded = envelope('input_trace.record');
  for (const artifacts of [
    recorded.artifacts.slice(1), [...recorded.artifacts, metadata('extra.log')],
    [metadata('recording.msgpack'), metadata('operation.json', { id: 'trace-recording.msgpack' }), metadata('input-trace.log')],
    [metadata('recording.msgpack', { size: 64 * 1024 * 1024 + 1 }), metadata('operation.json'), metadata('input-trace.log')],
  ]) assert.throws(() => decodeInputTraceRecord({ result: recorded.result, artifacts }, 'trace-metadata-log', record), ApiError);
  assert.throws(() => decodeInputTracePlayback(envelope('input_trace.record', result('input_trace.playback')), null, playback), ApiError);
  assert.throws(() => decodeInputTracePlayback(envelope('input_trace.playback', { ...result('input_trace.playback'), events: 0 }), null, playback), ApiError);
  assert.throws(() => decodeInputTraceRecord({ ...recorded, error: null }, null, record), ApiError);
});

test('目录代际撤销旧成功与旧拒绝，刷新清入口且拒绝重复ID或错误模式', async () => {
  for (const rejects of [false, true]) {
    const delayed = deferred<{ data: unknown; logId: string }>(); let calls = 0;
    const automation = createAutomation(gateway(), { operations: { list: async () => ++calls === 1 ? delayed.promise : { data: [], logId: 'current-log' } } });
    const old = automation.refreshOperations(signal()); const rejected = assert.rejects(old, ApiError);
    await automation.refreshOperations(signal()); await rejected;
    if (rejects) delayed.reject(new Error('晚到目录失败')); else delayed.resolve({ data: definitions(), logId: 'old-log' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(automation.snapshot().logId, 'current-log'); assert.equal(automation.snapshot().error, null); assert.equal(automation.snapshot().operations.length, 0);
    assert.throws(() => automation.mousePosition(signal()), ApiError); automation.dispose();
  }
  for (const data of [[...definitions(), definitions()[0]], [{ id: operation('sequence.run'), title: '错误目录', input_schema: { type: 'array' } }], null]) {
    const automation = createAutomation(gateway(), { operations: { list: async () => ({ data, logId: 'invalid-directory-log' }) } });
    await assert.rejects(automation.refreshOperations(signal()), (error: unknown) => error instanceof ApiError && error.logId === 'invalid-directory-log');
    assert.equal(automation.snapshot().operations.length, 0); automation.dispose();
  }
  for (const closed of [false, true]) {
    const delayed = deferred<{ data: unknown; logId: string }>(); let calls = 0;
    const automation = createAutomation(gateway(), { operations: { list: async () => ++calls === 1 ? { data: definitions(), logId: 'first-log' } : delayed.promise } });
    await automation.refreshOperations(signal());
    const controller = new AbortController(); const pending = automation.refreshOperations(controller.signal);
    assert.equal(automation.snapshot().operations.length, 0); assert.equal(automation.snapshot().refreshing, true);
    assert.throws(() => automation.mousePosition(signal()), ApiError);
    if (closed) automation.dispose(); else controller.abort(); await assert.rejects(pending, ApiError);
    delayed.resolve({ data: definitions(), logId: 'late-log' }); await new Promise((resolve) => setImmediate(resolve));
    assert.equal(automation.snapshot().operations.length, 0); assert.equal(automation.snapshot().refreshing, false); automation.dispose();
  }
  const automation = createAutomation(gateway());
  assert.throws(() => automation.refreshOperations(signal()), (error: unknown) => error instanceof ApiError && error.code === 'automation_catalog_not_configured');
  await automation.runSequence(sequence, signal()); assert.equal(automation.snapshot().operations.length, 0); automation.dispose();
});

test('各恢复入口拒绝错操作票据，查询和显式取消校验真实任务身份', async () => {
  for (const invocation of invocations) {
    const automation = createAutomation(gateway(invocation.action, {
      getJob: async () => ({ data: { id: 'other-job', operation: operation(invocation.action), status: 'succeeded', result: envelope(invocation.action) }, logId: 'wrong-query-log' }),
      cancelJob: async () => ({ data: { id: 'automation-job', operation: 'plugin.other.run', status: 'cancelled' }, logId: 'wrong-cancel-log' }),
    }));
    const ticket = { id: 'automation-job', operation: operation(invocation.action), submitLogId: 'submit-log' };
    assert.throws(() => invocation.resume(automation, { ...ticket, operation: 'plugin.other.run' }, signal()), ApiError);
    assert.throws(() => automation.queryJob({ ...ticket, operation: 'plugin.other.run' }, signal()), ApiError);
    assert.throws(() => automation.cancel({ ...ticket, operation: 'plugin.other.run' }, signal()), ApiError);
    await assert.rejects(automation.queryJob(ticket, signal()), (error: unknown) => error instanceof ApiError && error.logId === 'wrong-query-log');
    await assert.rejects(invocation.resume(automation, ticket, signal()), (error: unknown) => error instanceof ApiError && error.logId === 'wrong-query-log');
    await assert.rejects(automation.cancel(ticket, signal()), (error: unknown) => error instanceof ApiError && error.logId === 'wrong-cancel-log');
    automation.dispose();
  }
  const automation = createAutomation(gateway());
  assert.throws(() => automation.cancelDesktop({ id: 'automation-job', operation: operation('sequence.run'), submitLogId: 'submit-log' }, signal()), ApiError);
  automation.dispose();
});

async function digest(blob: Blob): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

test('HTTP轨迹及诊断产物按原字节和摘要下载，不把MessagePack当JSON解析', async () => {
  const names: readonly ('recording.msgpack' | 'operation.json' | 'input-trace.log')[] = ['recording.msgpack', 'operation.json', 'input-trace.log'];
  const bytes = new Blob([new Uint8Array([0x9a, 0xa1, 0x78, 0x00, 0xff, 0xc2])], { type: 'application/octet-stream' });
  const bodies = new Map<string, Blob>(names.map((name) => [name, name === 'recording.msgpack' ? bytes : new Blob([name === 'operation.json' ? '{"operation":"record"}' : 'InputTrace\nexit=0\n'])]));
  const artifacts: ArtifactDto[] = [];
  for (const name of names) {
    const blob = bodies.get(name); assert.ok(blob);
    artifacts.push(metadata(name, { size: blob.size, sha256: await digest(blob) }));
  }
  const calls: string[] = [];
  const client = createApiClient({ baseUrl: 'http://localhost:3000', transport: async (request) => {
    const path = requestUrl(request).pathname; calls.push(path);
    const name = names.find((name) => path === `/api/v2/artifacts/trace-${name}/content`);
    const blob = name ? bodies.get(name) : undefined; assert.ok(blob);
    return new Response(blob, { headers: { 'content-type': blob.type || 'application/octet-stream', 'x-deviceforge-log-id': 'trace-download-log' } });
  } });
  const automation = createHttpAutomation(client);
  const published = { result: {}, artifacts };
  for (const name of names) {
    const downloaded = await automation.downloadTrace(published, name, signal());
    assert.equal(downloaded.logId, 'trace-download-log');
    const expected = bodies.get(name); assert.ok(expected);
    assert.deepEqual(new Uint8Array(await downloaded.data.arrayBuffer()), new Uint8Array(await expected.arrayBuffer()));
  }
  await automation.downloadTrace({ result: {}, artifacts: artifacts.filter((artifact) => artifact.filename !== 'recording.msgpack') }, 'operation.json', signal());
  await assert.rejects(automation.downloadTrace({ ...published, artifacts: artifacts.map((artifact) => artifact.filename === 'recording.msgpack' ? { ...artifact, sha256: '0'.repeat(64) } : artifact) }, 'recording.msgpack', signal()), (error: unknown) => error instanceof ApiError && error.code === 'artifact_digest_mismatch' && error.logId === 'trace-download-log');
  bodies.set('recording.msgpack', new Blob(['size mismatch']));
  await assert.rejects(automation.downloadTrace(published, 'recording.msgpack', signal()), (error: unknown) => error instanceof ApiError && error.code === 'artifact_size_mismatch' && error.logId === 'trace-download-log');
  const requested = calls.length;
  assert.throws(() => automation.downloadTrace({ result: {}, artifacts: [metadata('other.file')] }, 'operation.json', signal()), ApiError);
  assert.equal(calls.length, requested); automation.dispose();
});

test('下载取消与销毁结束忽略信号的等待，已收到字节响应时保留日志', async () => {
  const bytes = new Blob(['opaque trace bytes']); const sha256 = await digest(bytes);
  const output = { result: {}, artifacts: [metadata('recording.msgpack', { size: bytes.size, sha256 }), metadata('operation.json'), metadata('input-trace.log')] };
  for (const closed of [false, true]) {
    for (const delivered of [false, true]) {
      const downloaded = deferred<{ data: Blob; logId: string }>(); const buffer = deferred<ArrayBuffer>(); const started = deferred<void>();
      class SlowBytes extends Blob {
        override arrayBuffer(): Promise<ArrayBuffer> { started.resolve(); return buffer.promise; }
      }
      const automation = createAutomation(gateway(), {}, { download: async () => {
        if (delivered) return { data: new SlowBytes([bytes]), logId: 'received-download-log' };
        started.resolve(); return downloaded.promise;
      } });
      const controller = new AbortController(); const waiting = automation.downloadTrace(output, 'recording.msgpack', controller.signal);
      await started.promise; if (closed) automation.dispose(); else controller.abort();
      await assert.rejects(waiting, (error: unknown) => error instanceof ApiError && error.kind === 'cancelled' && error.logId === (delivered ? 'received-download-log' : null));
      if (delivered) buffer.reject(new Error('晚到字节失败')); else downloaded.reject(new Error('晚到下载失败'));
      await new Promise((resolve) => setImmediate(resolve)); automation.dispose();
    }
  }
});

test('销毁覆盖设备与桌面两个任务执行器，晚成功不可交付且晚拒绝被消费', async () => {
  for (const action of ['sequence.run', 'windows.mouse.position'] satisfies AutomationOperation[]) {
    for (const rejects of [false, true]) {
      const delayed = deferred<{ data: TaskRecord; logId: string }>(); const started = deferred<void>();
      const automation = createAutomation(gateway(action, {
        submit: async (id) => ({ data: { id: 'automation-job', operation: id, status: 'running' }, logId: 'running-log' }),
        getJob: async () => { started.resolve(); return delayed.promise; },
      }), { pollIntervalMs: 0 });
      const waiting = action === 'sequence.run' ? automation.runSequence(sequence, signal()) : automation.mousePosition(signal());
      await started.promise; automation.dispose();
      await assert.rejects(waiting, (error: unknown) => error instanceof JobWaitFailure && error.submitLogId === 'running-log' && error.lastKnownLogId === 'running-log');
      if (rejects) delayed.reject(new Error('晚到任务失败'));
      else delayed.resolve({ data: { id: 'automation-job', operation: operation(action), status: 'succeeded', result: envelope(action) }, logId: 'late-log' });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(automation.snapshot().operations.length, 0); assert.throws(() => automation.mousePosition(signal()), ApiError);
    }
  }
});
