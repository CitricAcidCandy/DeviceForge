import assert from 'node:assert/strict';
import test from 'node:test';
import { createHttpMirroringStreaming, createMirroringStreaming } from '../src/features/mirroring-streaming/index.ts';
import type { MirroringPacket } from '../src/features/mirroring-streaming/index.ts';
import { ApiError, createApiClient } from '../src/shared/api/index.ts';
import type { SessionGateway, SessionInfo, SessionOutputPage } from '../src/shared/api/index.ts';
import { deferred, requestUrl, signal, success } from './fixtures.ts';

const id = '12345678-1234-1234-1234-123456789abc';
const operation = 'plugin.mirroring.open';
const input = { device_id: 'emulator-5554', audio: true, control: true, reconnect_attempts: 2 };
const definitions = { revision: 1, sessions: [{ id: operation, title: '直播投屏', input_schema: { type: 'object' }, execution: { api_version: 1, source: 'declared', total_timeout_ms: 3600000 } }] };
function info(status: SessionInfo['status'] = 'opening', output_sequence = 0, changes: Partial<SessionInfo> = {}): SessionInfo {
  return { id, operation, plugin_id: 'mirroring', generation: 'generation-1', created_at: 1, status, output_sequence,
    ...(status === 'finished' ? { completion: { cleanup: 'complete', process_exited: true } } : {}), ...changes };
}
function frame(kind: number, value: unknown, flags = 0, epoch = 1): number[] {
  const payload = value instanceof Uint8Array ? value : new TextEncoder().encode(JSON.stringify(value));
  const bytes = new Uint8Array(24 + payload.length); bytes.set([68, 70, 77, 76, 1, kind]);
  const view = new DataView(bytes.buffer); view.setUint16(6, flags); view.setUint32(16, payload.length); view.setUint32(20, epoch); bytes.set(payload, 24); return Array.from(bytes);
}
const config = () => frame(1, { codec: 'h264', format: 'annexb', width: 640, height: 480 });
const status = (epoch = 1) => frame(5, { state: 'streaming', attempt: epoch - 1 }, 0, epoch);
const sps = () => frame(2, new Uint8Array([0, 0, 0, 1, 103, 100, 0, 31]), 2);
function page(chunks: readonly number[][], after = 0, state: SessionInfo['status'] = 'running'): SessionOutputPage {
  return { session: info(state, after + chunks.length), chunks: chunks.map((bytes, index) => ({ sequence: after + index + 1, stream: 'stdout', bytes })), next_sequence: after + chunks.length };
}
function gateway(changes: Partial<SessionGateway> = {}): SessionGateway {
  return { definitions: async () => ({ data: definitions, logId: 'definitions-log' }), list: async () => ({ data: [], logId: 'list-log' }),
    open: async () => ({ data: info(), logId: 'open-log' }), get: async () => ({ data: info('running', 10), logId: 'query-log' }),
    output: async () => ({ data: page([status(), config(), sps()]), logId: 'output-log' }),
    send: async () => ({ data: { id, accepted: true }, logId: 'input-log' }), eof: async () => ({ data: { id, accepted: true }, logId: 'eof-log' }),
    cancel: async () => ({ data: info('stopping'), logId: 'cancel-log' }), remove: async () => ({ data: { id }, logId: 'remove-log' }), ...changes };
}
async function opened(changes: Partial<SessionGateway> = {}, packets: MirroringPacket[] = []) {
  const mirror = createMirroringStreaming(gateway(changes), { sink: { packet: (packet) => { packets.push(packet); } } });
  await mirror.refreshDefinitions(signal()); await mirror.open(input, signal()); return mirror;
}

test('HTTP工厂发现真实交互操作，逐块分帧保留日志与原字节，控制绑定观察代次', async () => {
  const requests: { path: string; body: unknown }[] = []; const observed: MirroringPacket[] = [];
  const client = createApiClient({ baseUrl: 'http://localhost:3000', transport: async (request, init) => {
    const path = requestUrl(request).pathname; const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null; requests.push({ path, body });
    if (path === '/api/v2/session-definitions') return success(definitions, 'definitions-log');
    if (path === '/api/v2/sessions') return success(info(), 'open-log');
    if (path.endsWith('/output')) return success(page([status(), config(), sps()]), 'output-log');
    if (path.endsWith('/input')) return success({ id, accepted: true }, 'input-log');
    throw new Error('未声明请求');
  } });
  const mirror = createHttpMirroringStreaming(client, { sink: { packet: (packet) => { observed.push(packet); } } });
  assert.throws(() => mirror.open(input, signal()), ApiError); await mirror.refreshDefinitions(signal()); await mirror.open(input, signal());
  assert.throws(() => mirror.sendControl({ type: 'rotate' }, signal()), ApiError);
  const output = await mirror.readOutput({ limit: 50 }, signal()); const sent = await mirror.sendControl({ type: 'text', text: '中文🙂' }, signal());
  assert.equal(output.logId, 'output-log'); assert.equal(output.data.cursor, 3); assert.equal(observed.length, 3); assert.equal(mirror.snapshot().pendingBytes, 0);
  assert.equal(sent.logId, 'input-log'); assert.deepEqual(requests[1]?.body, { operation, input });
  const posted = requests.at(-1)?.body; assert.ok(posted !== null && typeof posted === 'object' && 'bytes' in posted && Array.isArray(posted.bytes));
  assert.equal(new TextDecoder().decode(new Uint8Array(posted.bytes)), '{"type":"text","text":"中文🙂","epoch":1}\n'); mirror.dispose();
});

test('同会话网络暂停后恢复保存半包与游标，读取失败不重新打开或重放控制', async () => {
  const full = config(); let reads = 0; let opens = 0; let sends = 0; const packets: MirroringPacket[] = [];
  const mirror = await opened({ open: async () => { ++opens; return { data: info(), logId: 'open-log' }; },
    output: async (_id, query) => { ++reads;
      if (reads === 1) return { data: page([full.slice(0, 27)]), logId: 'partial-log' };
      if (reads === 2) throw new ApiError('network', 'connection_lost', '网络断开', null, 'disconnect-log');
      assert.equal(query.after, 1); return { data: page([full.slice(27), sps(), status()], 1), logId: 'restored-log' };
    }, send: async () => { ++sends; return { data: { id, accepted: true }, logId: 'sent-log' }; } }, packets);
  await mirror.readOutput({}, signal()); assert.equal(mirror.snapshot().cursor, 1); assert.equal(mirror.snapshot().pendingBytes, 27);
  await assert.rejects(mirror.readOutput({}, signal()), (error: unknown) => error instanceof ApiError && error.logId === 'disconnect-log');
  await mirror.resume(id, signal()); await mirror.readOutput({}, signal()); await mirror.sendControl({ type: 'rotate' }, signal());
  assert.equal(opens, 1); assert.equal(sends, 1); assert.equal(packets.length, 3); assert.equal(mirror.snapshot().cursor, 4); mirror.dispose();
});

test('媒体读取只返回本次完成包，与计数读取共享游标且跨页大帧保持有界', async () => {
  const large = frame(2, new Uint8Array(4 * 1024 * 1024).fill(255), 1);
  const blocks = [status(), config(), sps()];
  for (let offset = 0; offset < large.length; offset += 8192) blocks.push(large.slice(offset, offset + 8192));
  const mirror = await opened({ output: async (_id, query) => {
    const after = query.after ?? 0; const selected = blocks.slice(after, after + (query.limit ?? 50));
    return { data: { session: info('running', blocks.length), chunks: selected.map((bytes, index) => ({ sequence: after + index + 1, stream: 'stdout', bytes })), next_sequence: after + selected.length }, logId: 'large-frame-log' };
  } });
  await mirror.readOutput({ limit: 100 }, signal());
  assert.equal(mirror.snapshot().packets, 3);
  const received: MirroringPacket[] = [];
  while (mirror.snapshot().cursor < blocks.length) received.push(...(await mirror.readPackets({ limit: 100 }, signal())).data.mediaPackets);
  assert.equal(received.length, 1); const packet = received[0]; assert.ok(packet?.kind === 'video');
  assert.equal(packet.bytes.byteLength, 4 * 1024 * 1024); assert.equal(packet.bytes.at(-1), 255);
  assert.equal(mirror.snapshot().pendingBytes, 0); assert.deepEqual((await mirror.readPackets({}, signal())).data.mediaPackets, []); mirror.dispose();
});

test('重连新代清旧媒体配置并以新epoch发送，不复用上一代按键', async () => {
  let reads = 0; const sent: number[][] = [];
  const mirror = await opened({ output: async () => {
    ++reads; return { data: reads === 1 ? page([status(), config(), sps()]) : page([frame(5, { state: 'reconnecting', attempt: 1 }, 0, 2), status(2)], 3), logId: `output-${reads}` };
  }, send: async (_id, value) => { sent.push([...value]); return { data: { id, accepted: true }, logId: 'sent' }; } });
  await mirror.readOutput({}, signal()); await mirror.sendControl({ type: 'key', action: 'down', keycode: 3 }, signal());
  await mirror.readOutput({}, signal()); assert.equal(mirror.snapshot().epoch, 2); assert.equal(mirror.snapshot().video, null);
  await mirror.sendControl({ type: 'key', action: 'up', keycode: 3 }, signal()); assert.equal(sent.length, 2);
  const first = sent[0]; const second = sent[1]; assert.ok(first); assert.ok(second);
  assert.match(new TextDecoder().decode(new Uint8Array(first)), /"epoch":1/); assert.match(new TextDecoder().decode(new Uint8Array(second)), /"epoch":2/);
  mirror.dispose();
});

test('取消和销毁及时结束忽略信号的网络等待，旧结果不能写回新选会话', async () => {
  for (const dispose of [false, true]) {
    const delayed = deferred<{ data: SessionOutputPage; logId: string }>(); const mirror = await opened({ output: () => delayed.promise });
    const controller = new AbortController(); const waiting = mirror.readOutput({}, controller.signal);
    assert.throws(() => mirror.readOutput({}, signal()), (error: unknown) => error instanceof ApiError && error.code === 'mirroring_output_busy');
    assert.throws(() => mirror.resume(id, signal()), (error: unknown) => error instanceof ApiError && error.code === 'mirroring_output_busy');
    if (dispose) mirror.dispose(); else controller.abort();
    await assert.rejects(waiting, ApiError); delayed.resolve({ data: page([status(), config(), sps()]), logId: 'late-log' });
    await new Promise((resolve) => setImmediate(resolve)); assert.equal(mirror.snapshot().cursor, 0); assert.equal(mirror.snapshot().packets, 0); mirror.dispose();
  }
  const delayed = deferred<{ data: SessionInfo; logId: string }>(); let opens = 0;
  const mirror = createMirroringStreaming(gateway({ open: async () => ++opens === 1 ? delayed.promise : { data: info('opening', 0, { generation: 'generation-2' }), logId: 'new-log' } }));
  await mirror.refreshDefinitions(signal()); const old = mirror.open(input, signal()); await mirror.open(input, signal()); await assert.rejects(old, ApiError);
  delayed.resolve({ data: info(), logId: 'old-log' }); await new Promise((resolve) => setImmediate(resolve)); assert.equal(mirror.snapshot().session?.generation, 'generation-2'); mirror.dispose();
});

test('截断终态、错身份和错游标均拒绝，帧交付取消禁止自动重放', async () => {
  for (const data of [page([config().slice(0, 25)], 0, 'finished'), { ...page([config()]), next_sequence: 2 }, { ...page([config()]), session: info('running', 1, { generation: 'other' }) }]) {
    const mirror = await opened({ output: async () => ({ data, logId: 'invalid-output-log' }) });
    await assert.rejects(mirror.readOutput({}, signal()), (error: unknown) => error instanceof ApiError && error.logId === 'invalid-output-log'); mirror.dispose();
  }
  const delayed = deferred<void>(); const entered = deferred<void>();
  const mirror = createMirroringStreaming(gateway(), { sink: { packet: () => { entered.resolve(); return delayed.promise; } } });
  await mirror.refreshDefinitions(signal()); await mirror.open(input, signal()); const controller = new AbortController(); const waiting = mirror.readOutput({}, controller.signal);
  await entered.promise; controller.abort(); await assert.rejects(waiting, (error: unknown) => error instanceof ApiError && error.logId === 'output-log');
  assert.throws(() => mirror.resume(id, signal()), (error: unknown) => error instanceof ApiError && error.code === 'mirroring_stream_restart_required');
  delayed.resolve(); mirror.dispose();
});

test('输入收据失败保留不确定状态，EOF只收敛控制而视频继续，取消不假定清理完成', async () => {
  const mirror = await opened({ output: async (_id, query) => ({ data: query.after === 0 ? page([status(), config(), sps()]) : page([], query.after), logId: 'output-log' }) });
  await mirror.readOutput({}, signal()); await mirror.eof(signal()); assert.equal(mirror.snapshot().inputState, 'eof');
  assert.throws(() => mirror.sendControl({ type: 'rotate' }, signal()), ApiError); await mirror.readOutput({}, signal()); await mirror.cancel(signal());
  assert.equal(mirror.snapshot().session?.status, 'stopping'); assert.equal(mirror.snapshot().session?.completion, undefined); mirror.dispose();
  const failed = await opened({ send: async () => { throw new ApiError('network', 'lost_receipt', '收据丢失', null, 'lost-log'); } });
  await failed.readOutput({}, signal()); await assert.rejects(failed.sendControl({ type: 'rotate' }, signal()), ApiError);
  assert.equal(failed.snapshot().inputState, 'uncertain'); assert.equal(failed.snapshot().logs.input, 'lost-log'); assert.throws(() => failed.sendControl({ type: 'rotate' }, signal()), ApiError); failed.dispose();
});
