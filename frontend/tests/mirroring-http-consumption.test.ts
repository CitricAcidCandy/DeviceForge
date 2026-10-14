import assert from 'node:assert/strict';
import test from 'node:test';
import { createHttpMirroring, createMirroring } from '../src/features/mirroring/index.ts';
import { ApiError, createApiClient } from '../src/services/api/index.ts';
import type { ArtifactDto, OperationDto } from '../src/services/api/index.ts';
import type { ArtifactReader, JobGateway, JsonData, TaskRecord } from '../src/shared/jobs/index.ts';
import { JobWaitFailure } from '../src/shared/jobs/index.ts';
import { decodeMirroringRecording, decodeMirroringStatus } from '../src/features/mirroring/utils/results.ts';
import { requireMirroringRequest } from '../src/features/mirroring/utils/rules.ts';
import { deferred, requestUrl, signal, success } from './fixtures.ts';

const request = { device_id: 'emulator-5554', duration_ms: 1100 };
const video = new Blob([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109])], { type: 'video/mp4' });
const operation = (action: string) => `plugin.mirroring.${action}`;
function definitions(): OperationDto[] {
  return ['runtime.status', 'record'].map((action) => ({ id: operation(action), title: action, input_schema: { type: 'object' } }));
}
function recording(changes: Record<string, unknown> = {}) {
  return { device_id: request.device_id, duration_ms: 2000, codec: 'h264', filename: 'screen.mp4', size: video.size, live_stream: false, ...changes };
}
function metadata(changes: Partial<ArtifactDto> = {}): ArtifactDto {
  return { id: 'recording-artifact', filename: 'screen.mp4', size: video.size, sha256: 'a'.repeat(64), media_type: 'video/mp4', created_at: 1, ...changes };
}
function envelope(value: unknown = recording(), artifacts = [metadata()]) { return { result: value, artifacts }; }
const status = () => ({ result: { available: true, version: 'scrcpy 3\n', recording: true, live_stream: false }, artifacts: [] });
const reader: ArtifactReader = { download: async () => ({ data: video, logId: 'download-log' }) };
function gateway(changes: Partial<JobGateway> = {}): JobGateway {
  return {
    submit: async (operation) => ({ data: { id: 'video-job', operation, status: 'succeeded', result: operation.endsWith('.record') ? envelope() : status() }, logId: 'submit-log' }),
    getJob: async () => ({ data: { id: 'video-job', operation: operation('record'), status: 'succeeded', result: envelope() }, logId: 'query-log' }),
    cancelJob: async () => ({ data: { id: 'video-job', operation: operation('record'), status: 'cancelled' }, logId: 'cancel-log' }),
    ...changes,
  };
}

test('真实HTTP只发现两项贡献并使用实际平铺输入，记录整秒时长与非直播结果', async () => {
  const calls: { path: string; body: unknown }[] = [];
  const client = createApiClient({ baseUrl: 'http://localhost:3000', transport: async (input, init) => {
    const url = requestUrl(input); const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ path: url.pathname, body });
    if (url.pathname.endsWith('/operations')) return success(definitions(), 'catalog-log');
    if (typeof body === 'object' && body !== null && 'operation' in body && typeof body.operation === 'string') {
      return success({ id: 'video-job', operation: body.operation, input: 'input' in body ? body.input : {}, created_at: 1, status: 'succeeded', result: body.operation.endsWith('.record') ? envelope() : status() }, 'submit-log');
    }
    throw new Error('未声明HTTP调用');
  } });
  const mirror = createHttpMirroring(client, { pollIntervalMs: 0 });
  assert.throws(() => mirror.record(request, signal()), ApiError);
  await mirror.refreshOperations(signal());
  const available = await mirror.runtimeStatus(signal());
  const recorded = await mirror.record({ ...request, max_size: 1280, max_fps: 30 }, signal());
  assert.equal(available.data.live_stream, false); assert.equal(recorded.data.result.duration_ms, 2000);
  assert.deepEqual(calls.slice(1).map((call) => call.body), [
    { operation: operation('runtime.status'), input: {} },
    { operation: operation('record'), input: { ...request, max_size: 1280, max_fps: 30 } },
  ]);
  assert.equal(mirror.snapshot().operations.length, 2); assert.equal(mirror.snapshot().logId, 'catalog-log');
  assert.equal(recorded.submitLogId, 'submit-log'); assert.equal(recorded.logId, 'submit-log');
  assert.ok(Object.isFrozen(recorded.data.result)); assert.ok(Object.isFrozen(recorded.data.artifacts[0]));
  mirror.dispose();
});

test('结果拒绝错误设备、非整秒、虚假直播、额外字段及产物大小不一致', () => {
  for (const changes of [
    { device_id: 'other-device' }, { duration_ms: 1100 }, { codec: 'h265' }, { live_stream: true },
    { audio: true }, { size: Number.MAX_SAFE_INTEGER + 1 }, { size: 128 * 1024 * 1024 + 1 }, { filename: 'other.mp4' },
  ]) assert.throws(() => decodeMirroringRecording(envelope(recording(changes)), 'record-error-log', request), (error: unknown) => error instanceof ApiError && error.logId === 'record-error-log');
  assert.throws(() => decodeMirroringRecording(envelope(recording(), [metadata({ size: video.size + 1 })]), null, request), ApiError);
  assert.throws(() => decodeMirroringRecording(envelope(recording(), [metadata(), metadata({ id: 'other-artifact' })]), null, request), ApiError);
  assert.throws(() => decodeMirroringStatus({ result: { ...status().result, reconnect: true }, artifacts: [] }, null), ApiError);
  assert.throws(() => decodeMirroringStatus({ result: status().result, artifacts: [metadata()] }, null), ApiError);
});

test('投屏状态区分直播能力与部署配置，兼容早期非直播状态而录像仍非直播', () => {
  for (const live_configured of [false, true]) {
    const value = decodeMirroringStatus({ result: { available: true, version: 'scrcpy 3.3.1', recording: true, live_stream: true, live_configured }, artifacts: [] }, 'live-status-log');
    assert.equal(value.live_stream, true);
    if (!value.live_stream) throw new Error('未得到直播能力状态');
    assert.equal(value.live_configured, live_configured);
  }
  assert.equal(decodeMirroringStatus(status(), null).live_stream, false);
  for (const result of [{ ...status().result, live_stream: true }, { ...status().result, live_stream: true, live_configured: 'true' }]) {
    assert.throws(() => decodeMirroringStatus({ result, artifacts: [] }, 'invalid-status-log'), (error: unknown) => error instanceof ApiError && error.logId === 'invalid-status-log');
  }
});

test('录像输入沿后端设备和数值边界，不接收路径、null或丢失字段的undefined', () => {
  for (const device_id of ['.device', '_device', ':5555', 'host:5555', 'a'.repeat(200)]) {
    requireMirroringRequest({ device_id, duration_ms: 1000, max_size: 64, max_fps: 1 });
    requireMirroringRequest({ device_id, duration_ms: 120000, max_size: 4096, max_fps: 60 });
  }
  for (const device_id of ['', '-device', '设备', 'a'.repeat(201), 'host/5555', 'host\n']) {
    assert.throws(() => requireMirroringRequest({ ...request, device_id }), ApiError);
  }
  for (const input of [
    { ...request, duration_ms: 999 }, { ...request, duration_ms: 120001 }, { ...request, duration_ms: 1000.5 },
    { ...request, duration_ms: Number.MAX_SAFE_INTEGER + 1 }, { ...request, max_size: 63 }, { ...request, max_size: 4097 },
    { ...request, max_fps: 0 }, { ...request, max_fps: 61 }, { ...request, max_fps: 30.5 },
    { ...request, max_size: null }, { ...request, max_size: undefined }, { ...request, max_fps: null }, { ...request, max_fps: undefined },
    { ...request, path: 'client.mp4' }, { ...request, input: {} },
  ]) assert.throws(() => requireMirroringRequest(input), ApiError);
});

test('请求冻结副本保留原设备与时长，缺省编码参数由后端决定', async () => {
  const submitted: JsonData[] = [];
  const waiting = deferred<{ data: TaskRecord; logId: string }>();
  const mirror = createMirroring(gateway({ submit: async (_operation, input) => { submitted.push(input); return waiting.promise; } }), reader);
  const original = { ...request };
  const pending = mirror.record(original, signal());
  original.device_id = 'other-device'; original.duration_ms = 3000;
  assert.deepEqual(submitted, [request]); assert.ok(Object.isFrozen(submitted[0]));
  waiting.resolve({ data: { id: 'video-job', operation: operation('record'), status: 'succeeded', result: envelope() }, logId: 'copy-log' });
  const completed = await pending;
  assert.equal(completed.data.result.device_id, request.device_id); assert.equal(completed.data.result.duration_ms, 2000);
  assert.equal(completed.logId, 'copy-log'); mirror.dispose();
});

test('取消等待保留原录像任务，目录失效不阻止查询、恢复与显式取消', async () => {
  let submissions = 0; let cancels = 0; let failed = false;
  const mirror = createMirroring(gateway({
    submit: async (id) => { submissions++; return { data: { id: 'video-job', operation: id, status: 'running' }, logId: 'submit-log' }; },
    cancelJob: async () => { cancels++; return { data: { id: 'video-job', operation: operation('record'), status: 'cancelled' }, logId: 'explicit-cancel-log' }; },
  }), reader, { pollIntervalMs: 10000, operations: { list: async () => {
    if (failed) throw new ApiError('http', 'missing_plugin', '投屏插件不可用', 503, 'catalog-error-log');
    return { data: definitions(), logId: 'catalog-log' };
  } } });
  await mirror.refreshOperations(signal());
  const controller = new AbortController(); const waiting = mirror.record(request, controller.signal);
  await new Promise((resolve) => setImmediate(resolve)); controller.abort();
  await assert.rejects(waiting, (error: unknown) => error instanceof JobWaitFailure && error.job.id === 'video-job'
    && error.job.operation === operation('record') && error.submitLogId === 'submit-log' && error.lastKnownLogId === 'submit-log');
  assert.equal(cancels, 0);
  failed = true; await assert.rejects(mirror.refreshOperations(signal()), (error: unknown) => error instanceof ApiError && error.logId === 'catalog-error-log');
  assert.equal(mirror.snapshot().operations.length, 0); assert.throws(() => mirror.record(request, signal()), ApiError);
  const ticket = { id: 'video-job', operation: operation('record'), submitLogId: 'submit-log' };
  assert.equal((await mirror.queryJob(ticket, signal())).logId, 'query-log');
  const resumed = await mirror.resumeRecord(ticket, request, signal());
  assert.equal(resumed.submitLogId, 'submit-log'); assert.equal(resumed.logId, 'query-log'); assert.equal(submissions, 1);
  assert.equal((await mirror.cancel(ticket, signal())).logId, 'explicit-cancel-log'); assert.equal(cancels, 1);
  mirror.dispose();
});

test('目录旧成功与旧拒绝都不能复活已撤销贡献，模式和重复ID严格校验', async () => {
  for (const rejects of [false, true]) {
    const delayed = deferred<{ data: unknown; logId: string }>(); let calls = 0;
    const mirror = createMirroring(gateway(), reader, { operations: { list: async () => ++calls === 1 ? delayed.promise : { data: [], logId: 'current-log' } } });
    const old = mirror.refreshOperations(signal()); const oldRejected = assert.rejects(old, ApiError);
    await mirror.refreshOperations(signal()); await oldRejected;
    if (rejects) delayed.reject(new Error('晚到目录拒绝')); else delayed.resolve({ data: definitions(), logId: 'old-log' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(mirror.snapshot().logId, 'current-log'); assert.equal(mirror.snapshot().error, null);
    assert.throws(() => mirror.runtimeStatus(signal()), ApiError); mirror.dispose();
  }
  for (const data of [
    [...definitions(), definitions()[0]], [{ id: operation('record'), title: '录像', input_schema: { type: 'array' } }],
    [{ id: operation('record'), title: '录像', input_schema: null }], null,
  ]) {
    const mirror = createMirroring(gateway(), reader, { operations: { list: async () => ({ data, logId: 'invalid-catalog-log' }) } });
    await assert.rejects(mirror.refreshOperations(signal()), (error: unknown) => error instanceof ApiError && error.logId === 'invalid-catalog-log');
    assert.equal(mirror.snapshot().operations.length, 0); mirror.dispose();
  }
});

test('目录刷新即清旧入口，取消与销毁及时结束忽略信号的读取', async () => {
  for (const closed of [false, true]) {
    const delayed = deferred<{ data: unknown; logId: string }>(); let calls = 0;
    const mirror = createMirroring(gateway(), reader, { operations: { list: async () => ++calls === 1 ? { data: definitions(), logId: 'first-log' } : delayed.promise } });
    await mirror.refreshOperations(signal());
    const controller = new AbortController(); const pending = mirror.refreshOperations(controller.signal);
    assert.equal(mirror.snapshot().operations.length, 0); assert.equal(mirror.snapshot().refreshing, true);
    assert.throws(() => mirror.record(request, signal()), ApiError);
    if (closed) mirror.dispose(); else controller.abort();
    await assert.rejects(pending, ApiError);
    delayed.resolve({ data: definitions(), logId: 'late-log' }); await new Promise((resolve) => setImmediate(resolve));
    assert.equal(mirror.snapshot().operations.length, 0); assert.equal(mirror.snapshot().refreshing, false); mirror.dispose();
  }
  const mirror = createMirroring(gateway(), reader);
  assert.throws(() => mirror.refreshOperations(signal()), (error: unknown) => error instanceof ApiError && error.code === 'mirroring_catalog_not_configured');
  assert.equal(mirror.snapshot().operations.length, 0); await mirror.runtimeStatus(signal()); mirror.dispose();
});

test('任务票据只接受所属操作，查询和取消拒绝错任务身份并保留日志', async () => {
  const mirror = createMirroring(gateway(), reader);
  const ticket = { id: 'video-job', operation: operation('record'), submitLogId: 'submit-log' };
  assert.throws(() => mirror.resumeStatus(ticket, signal()), ApiError);
  assert.throws(() => mirror.resumeRecord({ ...ticket, operation: operation('runtime.status') }, request, signal()), ApiError);
  assert.throws(() => mirror.queryJob({ ...ticket, operation: 'plugin.other.record' }, signal()), ApiError);
  assert.throws(() => mirror.cancel({ ...ticket, operation: 'plugin.other.record' }, signal()), ApiError);
  mirror.dispose();
  const wrong = createMirroring(gateway({
    getJob: async () => ({ data: { id: 'other-job', operation: operation('record'), status: 'succeeded', result: envelope() }, logId: 'wrong-query-log' }),
    cancelJob: async () => ({ data: { id: 'video-job', operation: operation('runtime.status'), status: 'cancelled' }, logId: 'wrong-cancel-log' }),
  }), reader);
  await assert.rejects(wrong.queryJob(ticket, signal()), (error: unknown) => error instanceof ApiError && error.logId === 'wrong-query-log');
  await assert.rejects(wrong.resumeRecord(ticket, request, signal()), (error: unknown) => error instanceof ApiError && error.logId === 'wrong-query-log');
  await assert.rejects(wrong.cancel(ticket, signal()), (error: unknown) => error instanceof ApiError && error.logId === 'wrong-cancel-log');
  wrong.dispose();
});

test('HTTP下载保持真实原字节，摘要、大小和MP4头失败保留下载日志', async () => {
  const digest = async (blob: Blob) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const wrongType = new Blob([new Uint8Array([0, 0, 0, 24, 102, 114, 101, 101, 105, 115, 111, 109])]);
  const shortBox = new Blob([new Uint8Array([0, 0, 0, 8, 102, 116, 121, 112, 105, 115, 111, 109])]);
  for (const entry of [
    { blob: video, hash: await digest(video), code: null },
    { blob: video, hash: '0'.repeat(64), code: 'artifact_digest_mismatch' },
    { blob: new Blob(['short']), hash: await digest(video), code: 'artifact_size_mismatch' },
    { blob: wrongType, hash: await digest(wrongType), code: 'invalid_mirroring_video' },
    { blob: shortBox, hash: await digest(shortBox), code: 'invalid_mirroring_video' },
  ]) {
    const client = createApiClient({ baseUrl: 'http://localhost:3000', transport: async (input) => {
      assert.equal(requestUrl(input).pathname, '/api/v2/artifacts/recording-artifact/content');
      return new Response(entry.blob, { headers: { 'content-type': 'video/mp4', 'x-deviceforge-log-id': 'raw-download-log' } });
    } });
    const mirror = createHttpMirroring(client);
    const published = decodeMirroringRecording(envelope(recording(), [metadata({ sha256: entry.hash })]), 'record-log', request);
    if (entry.code === null) {
      const downloaded = await mirror.downloadRecording(published, signal());
      assert.equal(downloaded.logId, 'raw-download-log');
      assert.deepEqual(new Uint8Array(await downloaded.data.arrayBuffer()), new Uint8Array(await video.arrayBuffer()));
    } else {
      await assert.rejects(mirror.downloadRecording(published, signal()), (error: unknown) => error instanceof ApiError && error.code === entry.code && error.logId === 'raw-download-log');
    }
    mirror.dispose();
  }
  let downloads = 0;
  const mirror = createMirroring(gateway(), { download: async () => { downloads++; return { data: video, logId: 'unexpected-log' }; } });
  const published = decodeMirroringRecording(envelope(), null, request);
  await assert.rejects(mirror.downloadRecording({ ...published, result: { ...published.result, size: video.size + 1 } }, signal()), ApiError);
  assert.equal(downloads, 0); mirror.dispose();
});

test('下载头部检查取消或销毁仍保留已收到的日志，晚拒绝被消费', async () => {
  for (const closed of [false, true]) {
    const header = deferred<ArrayBuffer>(); const started = deferred<void>();
    class HeaderBytes extends Blob {
      override arrayBuffer(): Promise<ArrayBuffer> { started.resolve(); return header.promise; }
    }
    class VideoBytes extends Blob {
      override slice(start?: number, end?: number, contentType?: string): Blob { return new HeaderBytes([super.slice(start, end, contentType)]); }
    }
    const blob = new VideoBytes([video]);
    const hash = await crypto.subtle.digest('SHA-256', await video.arrayBuffer());
    const sha256 = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
    const mirror = createMirroring(gateway(), { download: async () => ({ data: blob, logId: 'header-download-log' }) });
    const controller = new AbortController();
    const waiting = mirror.downloadRecording(decodeMirroringRecording(envelope(recording(), [metadata({ sha256 })]), null, request), controller.signal);
    await started.promise; if (closed) mirror.dispose(); else controller.abort();
    await assert.rejects(waiting, (error: unknown) => error instanceof ApiError && error.kind === 'cancelled' && error.logId === 'header-download-log');
    header.reject(new Error('晚到字节失败')); await new Promise((resolve) => setImmediate(resolve)); mirror.dispose();
  }
});

test('销毁结束忽略信号的任务等待，不交付晚成功且消费晚拒绝', async () => {
  for (const rejects of [false, true]) {
    const delayed = deferred<{ data: TaskRecord; logId: string }>(); const started = deferred<void>();
    const mirror = createMirroring(gateway({
      submit: async (id) => ({ data: { id: 'video-job', operation: id, status: 'running' }, logId: 'running-log' }),
      getJob: async () => { started.resolve(); return delayed.promise; },
    }), reader, { pollIntervalMs: 0 });
    const waiting = mirror.record(request, signal()); await started.promise; mirror.dispose();
    await assert.rejects(waiting, (error: unknown) => error instanceof JobWaitFailure && error.submitLogId === 'running-log' && error.lastKnownLogId === 'running-log');
    if (rejects) delayed.reject(new Error('晚到任务失败'));
    else delayed.resolve({ data: { id: 'video-job', operation: operation('record'), status: 'succeeded', result: envelope() }, logId: 'late-log' });
    await new Promise((resolve) => setImmediate(resolve)); assert.equal(mirror.snapshot().operations.length, 0);
    assert.throws(() => mirror.record(request, signal()), ApiError);
  }
});
