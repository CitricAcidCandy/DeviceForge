import assert from 'node:assert/strict';
import test from 'node:test';
import { createAndroidUnicodeInput } from '../src/features/android-input/index.ts';
import { HostError } from '../src/plugin-sdk/index.ts';
import type { DeviceAccess, DeviceAction, DeviceSnapshot, HostResult, Job } from '../src/plugin-sdk/index.ts';

const reference = { providerId: 'provider', generation: 'generation-2', localId: 'device-7' };
const snapshot: DeviceSnapshot = {
  providers: [],
  directories: [],
  selection: reference,
  selected: { reference, state: 'online', rawState: 'device', model: '测试设备', capabilities: [{ id: 'input', version: 1, available: true, reason: null }] },
};

function job(result: Job['result'], status: Job['status'] = 'succeeded'): Job {
  return { id: 'job-input', operation: 'android.input', status, result, error: null };
}

function devices(result: HostResult<Job> | Promise<HostResult<Job>>, onInvoke: (action: DeviceAction, signal: AbortSignal) => void = () => {}): DeviceAccess {
  return {
    refreshProviders: async () => ({ data: [], logId: null }), refreshDirectories: async () => ({ data: [], logId: null }),
    refreshProvider: async () => ({ data: snapshot.directories[0]!, logId: null }), select: () => {}, snapshot: () => snapshot,
    subscribe: () => () => {}, invoke: async (action, signal) => { onInvoke(action, signal); return await result; },
  };
}

test('可打印 ASCII 输入按 UTF-8 字节限额原样提交并保留日志', async () => {
  let received: DeviceAction | null = null;
  const host = devices({ data: job({ result: { device_id: reference.localId, action: 'text', dispatched: true }, artifacts: [] }), logId: 'input-log' }, (action) => { received = action; });
  const input = createAndroidUnicodeInput(host);
  try {
    const response = await input.send({ text: 'Hello 123', enter: true }, new AbortController().signal);
    assert.equal(response.logId, 'input-log'); assert.deepEqual(response.data, { device_id: reference.localId, action: 'text', dispatched: true });
    assert.deepEqual(received, { providerId: reference.providerId, generation: reference.generation, deviceId: reference.localId,
      capability: 'input', version: 1, input: { action: { kind: 'text', text: 'Hello 123', enter: true } } });
  } finally { input.dispose(); }
});

test('Unicode 输入保留字段并要求 adb_keyboard_base64 结果与字节数一致', async () => {
  const received: { action: DeviceAction | null } = { action: null };
  const text = '中文🙂';
  const bytes = new TextEncoder().encode(text).byteLength;
  const host = devices({ data: job({ result: { device_id: reference.localId, action: 'text', transport: 'adb_keyboard_base64', bytes, dispatched: true }, artifacts: [] }), logId: 'unicode-log' }, (action) => { received.action = action; });
  const input = createAndroidUnicodeInput(host);
  try {
    const response = await input.send({ text }, new AbortController().signal);
    assert.equal(response.logId, 'unicode-log');
    if (!('transport' in response.data)) throw new Error('Unicode 结果缺少传输方式');
    assert.equal(response.data.transport, 'adb_keyboard_base64'); assert.equal(response.data.bytes, bytes);
    const action = received.action;
    if (action === null) throw new Error('未记录设备动作');
    assert.deepEqual(action.input, { action: { kind: 'text', text } });
  } finally { input.dispose(); }
});

test('控制字符和 UTF-8 超限在本地拒绝且不调用提供者', async () => {
  let calls = 0;
  const host = devices({ data: job({ result: { result: {}, artifacts: [] } }), logId: null }, () => { calls += 1; });
  const input = createAndroidUnicodeInput(host);
  try {
    for (const value of [{ text: 'line\nfeed' }, { text: 'a'.repeat(1025) }, { text: '🙂'.repeat(1025) }]) {
      await assert.rejects(input.send(value, new AbortController().signal), (error: unknown) => error instanceof HostError && error.code === 'invalid_android_input');
    }
    assert.equal(calls, 0);
  } finally { input.dispose(); }
});

test('提供者能力不可用或设备未选择时不猜平台并保留本地错误', async () => {
  let calls = 0;
  const unavailable: DeviceSnapshot = { ...snapshot, selected: { ...snapshot.selected!, state: 'offline', capabilities: [{ id: 'input', version: 1, available: false, reason: '未授权' }] } };
  const host = devices({ data: job({ result: { result: {}, artifacts: [] } }), logId: null }, () => { calls += 1; });
  const unavailableHost = { ...host, snapshot: () => unavailable };
  const input = createAndroidUnicodeInput(unavailableHost);
  try {
    await assert.rejects(input.send({ text: 'hello' }, new AbortController().signal), (error: unknown) => error instanceof HostError && error.code === 'android_input_device_unavailable');
    await assert.rejects(createAndroidUnicodeInput({ ...host, snapshot: () => ({ ...snapshot, selection: null, selected: null }) }).send({ text: 'hello' }, new AbortController().signal), (error: unknown) => error instanceof HostError && error.code === 'android_input_device_not_selected');
    assert.equal(calls, 0);
  } finally { input.dispose(); }
});

test('调用方取消和销毁隔离晚到结果，提供者收到代际信号', async () => {
  let resolve: ((value: HostResult<Job>) => void) | undefined;
  let requestSignal: AbortSignal | undefined;
  const host = devices(new Promise<HostResult<Job>>((finish) => { resolve = finish; }), (_action, signal) => { requestSignal = signal; });
  const input = createAndroidUnicodeInput(host); const controller = new AbortController();
  const waiting = input.send({ text: '晚到🙂' }, controller.signal);
  controller.abort();
  await assert.rejects(waiting, (error: unknown) => error instanceof HostError && error.kind === 'cancelled');
  assert.equal(requestSignal?.aborted, true);
  resolve?.({ data: job({ result: { device_id: reference.localId, action: 'text', transport: 'adb_keyboard_base64', bytes: 9, dispatched: true }, artifacts: [] }), logId: 'late-log' });
  input.dispose();
});

test('任务失败只暴露稳定错误码并保留宿主日志 ID', async () => {
  const host = devices({ data: job({ result: { result: null, artifacts: [] } }, 'failed'), logId: 'failed-input-log' });
  const input = createAndroidUnicodeInput(host);
  try {
    await assert.rejects(input.send({ text: '失败🙂' }, new AbortController().signal), (error: unknown) =>
      error instanceof HostError && error.code === 'android_input_failed' && error.logId === 'failed-input-log' && !error.message.includes('原始'));
  } finally { input.dispose(); }
});
