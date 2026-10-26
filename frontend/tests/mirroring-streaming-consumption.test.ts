import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createHttpMirroringStreaming,
  createMirroringStreaming,
} from '../src/features/mirroring-streaming/index.ts';
import type { MirroringPacket } from '../src/features/mirroring-streaming/index.ts';
import { ApiError, createApiClient, createHttpSessionGateway } from '../src/services/api/index.ts';
import type { SessionGateway, SessionInfo, SessionOutputPage } from '../src/services/api/index.ts';
import { decodeStreamPage } from '../src/features/mirroring-streaming/utils/rules.ts';
import { deferred, requestUrl, signal, success } from './fixtures.ts';

const id = '12345678-1234-1234-1234-123456789abc';
const operation = 'plugin.mirroring.open';
const input = { device_id: 'emulator-5554', audio: true, control: true, reconnect_attempts: 2 };
const definitions = {
  revision: 1,
  sessions: [
    {
      id: operation,
      title: '直播投屏',
      input_schema: { type: 'object' },
      execution: { api_version: 1, source: 'declared', total_timeout_ms: 3600000 },
    },
  ],
};
function info(
  status: SessionInfo['status'] = 'opening',
  output_sequence = 0,
  changes: Partial<SessionInfo> = {},
): SessionInfo {
  return {
    id,
    operation,
    plugin_id: 'mirroring',
    generation: 'generation-1',
    created_at: 1,
    status,
    output_sequence,
    ...(status === 'finished' ? { completion: { cleanup: 'complete', process_exited: true } } : {}),
    ...changes,
  };
}
function frame(kind: number, value: unknown, flags = 0, epoch = 1): number[] {
  const payload =
    value instanceof Uint8Array ? value : new TextEncoder().encode(JSON.stringify(value));
  const bytes = new Uint8Array(24 + payload.length);
  bytes.set([68, 70, 77, 76, 1, kind]);
  const view = new DataView(bytes.buffer);
  view.setUint16(6, flags);
  view.setUint32(16, payload.length);
  view.setUint32(20, epoch);
  bytes.set(payload, 24);
  return Array.from(bytes);
}
const config = () => frame(1, { codec: 'h264', format: 'annexb', width: 640, height: 480 });
const status = (epoch = 1) => frame(5, { state: 'streaming', attempt: epoch - 1 }, 0, epoch);
const sps = () => frame(2, new Uint8Array([0, 0, 0, 1, 103, 100, 0, 31]), 2);
function page(
  chunks: readonly number[][],
  after = 0,
  state: SessionInfo['status'] = 'running',
): SessionOutputPage {
  return {
    session: info(state, after + chunks.length),
    chunks: chunks.map((bytes, index) => ({
      sequence: after + index + 1,
      stream: 'stdout',
      bytes,
    })),
    next_sequence: after + chunks.length,
  };
}
function gateway(changes: Partial<SessionGateway> = {}): SessionGateway {
  return {
    definitions: async () => ({ data: definitions, logId: 'definitions-log' }),
    list: async () => ({ data: [], logId: 'list-log' }),
    open: async () => ({ data: info(), logId: 'open-log' }),
    get: async () => ({ data: info('running', 10), logId: 'query-log' }),
    output: async () => ({ data: page([status(), config(), sps()]), logId: 'output-log' }),
    send: async () => ({ data: { id, accepted: true }, logId: 'input-log' }),
    eof: async () => ({ data: { id, accepted: true }, logId: 'eof-log' }),
    cancel: async () => ({ data: info('stopping'), logId: 'cancel-log' }),
    release: async () => ({ data: info('stopping'), logId: 'release-log' }),
    remove: async () => ({ data: { id }, logId: 'remove-log' }),
    ...changes,
  };
}
async function opened(changes: Partial<SessionGateway> = {}, packets: MirroringPacket[] = []) {
  const mirror = createMirroringStreaming(gateway(changes), {
    sink: {
      packet: (packet) => {
        packets.push(packet);
      },
    },
  });
  await mirror.refreshDefinitions(signal());
  await mirror.open(input, signal());
  return mirror;
}

test('HTTP工厂发现真实交互操作，逐块分帧保留日志与原字节，控制绑定观察代次', async () => {
  const requests: { path: string; body: unknown }[] = [];
  const observed: MirroringPacket[] = [];
  const client = createApiClient({
    baseUrl: 'http://localhost:3000',
    transport: async (request, init) => {
      const path = requestUrl(request).pathname;
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      requests.push({ path, body });
      if (path === '/api/v2/session-definitions') return success(definitions, 'definitions-log');
      if (path === '/api/v2/sessions') return success(info(), 'open-log');
      if (path.endsWith('/output')) return success(page([status(), config(), sps()]), 'output-log');
      if (path.endsWith('/input')) return success({ id, accepted: true }, 'input-log');
      throw new Error('未声明请求');
    },
  });
  const mirror = createHttpMirroringStreaming(client, {
    sink: {
      packet: (packet) => {
        observed.push(packet);
      },
    },
  });
  assert.throws(() => mirror.open(input, signal()), ApiError);
  await mirror.refreshDefinitions(signal());
  await mirror.open(input, signal());
  assert.throws(() => mirror.sendControl({ type: 'rotate' }, signal()), ApiError);
  const output = await mirror.readOutput({ limit: 50 }, signal());
  const sent = await mirror.sendControl({ type: 'text', text: '中文🙂' }, signal());
  assert.equal(output.logId, 'output-log');
  assert.equal(output.data.cursor, 3);
  assert.equal(observed.length, 3);
  assert.equal(mirror.snapshot().pendingBytes, 0);
  assert.equal(sent.logId, 'input-log');
  assert.deepEqual(requests[1]?.body, { operation, input });
  const posted = requests.at(-1)?.body;
  assert.ok(
    posted !== null &&
      typeof posted === 'object' &&
      'bytes' in posted &&
      Array.isArray(posted.bytes),
  );
  assert.equal(
    new TextDecoder().decode(new Uint8Array(posted.bytes)),
    '{"type":"text","text":"中文🙂","epoch":1}\n',
  );
  mirror.dispose();
});

test('兼容模式剪贴板仅显式启用时发布，不进入媒体批次且换代释放清空', async () => {
  for (const enabled of [true, false]) {
    const observed: MirroringPacket[] = [];
    let reads = 0;
    const mirror = createMirroringStreaming(gateway({
      output: async (_id, query) => {
        ++reads;
        const chunks = reads === 1 ? [status(), frame(6, { text: '设备剪贴板' })] :
          reads === 2 ? [frame(6, { text: '' })] : [status(2)];
        return { data: page(chunks, query.after), logId: 'output-log' };
      },
      release: async () => ({ data: info('finished'), logId: 'release-log' }),
    }), { sink: { packet: (packet) => { observed.push(packet); } } });
    await mirror.refreshDefinitions(signal());
    await mirror.open({ ...input, clipboard_autosync: enabled }, signal());
    const first = await mirror.readPackets({ limit: 10 }, signal());
    assert.equal(first.data.mediaPackets.some((packet) => packet.kind === 'clipboard'), false);
    assert.equal(observed.some((packet) => packet.kind === 'clipboard'), false);
    assert.equal(mirror.snapshot().clipboard?.text ?? null, enabled ? '设备剪贴板' : null);
    const sequence = mirror.snapshot().clipboard?.sequence ?? 0;
    await mirror.readOutput({ limit: 10 }, signal());
    assert.equal(mirror.snapshot().clipboard?.text ?? null, enabled ? '' : null);
    assert.equal(mirror.snapshot().clipboard?.sequence ?? 0, enabled ? sequence + 1 : 0);
    await mirror.readOutput({ limit: 10 }, signal());
    assert.equal(mirror.snapshot().clipboard, null);
    await mirror.release(signal());
    assert.equal(mirror.snapshot().clipboard, null);
    mirror.dispose();
  }
});

test('兼容模式控制关闭时不接收剪贴板，停止后清空已有正文', async () => {
  const mirror = createMirroringStreaming(gateway({
    output: async () => ({ data: page([status(), frame(6, { text: 'private' })]), logId: 'output-log' }),
  }));
  await mirror.refreshDefinitions(signal());
  await mirror.open({ ...input, control: false, clipboard_autosync: true }, signal());
  await mirror.readOutput({}, signal());
  assert.equal(mirror.snapshot().clipboard, null);
  mirror.dispose();
});

test('同会话网络暂停后恢复保存半包与游标，读取失败不重新打开或重放控制', async () => {
  const full = config();
  let reads = 0;
  let opens = 0;
  let sends = 0;
  const packets: MirroringPacket[] = [];
  const mirror = await opened(
    {
      open: async () => {
        ++opens;
        return { data: info(), logId: 'open-log' };
      },
      output: async (_id, query) => {
        ++reads;
        if (reads === 1) return { data: page([full.slice(0, 27)]), logId: 'partial-log' };
        if (reads === 2)
          throw new ApiError('network', 'connection_lost', '网络断开', null, 'disconnect-log');
        assert.equal(query.after, 1);
        return { data: page([full.slice(27), sps(), status()], 1), logId: 'restored-log' };
      },
      send: async () => {
        ++sends;
        return { data: { id, accepted: true }, logId: 'sent-log' };
      },
    },
    packets,
  );
  await mirror.readOutput({}, signal());
  assert.equal(mirror.snapshot().cursor, 1);
  assert.equal(mirror.snapshot().pendingBytes, 27);
  await assert.rejects(
    mirror.readOutput({}, signal()),
    (error: unknown) => error instanceof ApiError && error.logId === 'disconnect-log',
  );
  await mirror.resume(id, signal());
  await mirror.readOutput({}, signal());
  await mirror.sendControl({ type: 'rotate' }, signal());
  assert.equal(opens, 1);
  assert.equal(sends, 1);
  assert.equal(packets.length, 3);
  assert.equal(mirror.snapshot().cursor, 4);
  mirror.dispose();
});

test('媒体输出页建立独立冻结副本，源字节与元数据修改不会污染消费', () => {
  const source = page([status(), config(), sps()]);
  const decoded = decodeStreamPage(source, info(), 0, 50, 'copy-log');
  assert.deepEqual(decoded, source);
  assert.ok(Object.isFrozen(decoded));
  assert.ok(Object.isFrozen(decoded.session));
  assert.ok(Object.isFrozen(decoded.chunks));
  for (const chunk of decoded.chunks) {
    assert.ok(Object.isFrozen(chunk));
    assert.ok(Object.isFrozen(chunk.bytes));
  }
  const first = source.chunks[0];
  assert.ok(first);
  first.bytes[0] = 0;
  first.sequence = 100;
  source.chunks.splice(0);
  source.session.generation = 'changed';
  assert.equal(decoded.chunks[0]?.bytes[0], 68);
  assert.equal(decoded.chunks[0]?.sequence, 1);
  assert.equal(decoded.chunks.length, 3);
  assert.equal(decoded.session.generation, 'generation-1');
});

test('同页连续媒体包完整按序交付且不会逐包通知界面', async (context) => {
  const notifications: number[] = [];
  for (const count of [1, 200]) {
    const delta = frame(2, new Uint8Array([0, 0, 0, 1, 65, 1]));
    const bytes = [status(), config(), sps(), ...Array.from({ length: count }, () => delta)].flat();
    const observed: MirroringPacket[] = [];
    const mirror = await opened(
      { output: async () => ({ data: page([bytes]), logId: 'continuous-output-log' }) },
      observed,
    );
    context.after(() => mirror.dispose());
    let updates = 0;
    const unsubscribe = mirror.subscribe(() => ++updates);
    const result = await mirror.readOutput({}, signal());
    unsubscribe();
    notifications.push(updates);
    assert.equal(result.data.cursor, 1);
    assert.equal(result.data.packets, count + 3);
    assert.equal(observed.length, count + 3);
    assert.deepEqual(
      observed.slice(0, 3).map((packet) => packet.kind),
      ['status', 'video_config', 'video'],
    );
    assert.ok(observed.slice(3).every((packet) =>
      packet.kind === 'video' &&
      !packet.configuration &&
      Buffer.from(packet.bytes).equals(Buffer.from(delta.slice(24))),
    ));
    assert.equal(mirror.snapshot().logs.output, 'continuous-output-log');
    assert.equal(mirror.snapshot().pendingBytes, 0);
  }
  assert.ok((notifications[0] ?? 0) > 0);
  assert.equal(notifications[0], notifications[1]);
});

test('媒体读取只返回本次完成包，与计数读取共享游标且跨页大帧保持有界', async () => {
  const large = frame(2, new Uint8Array(4 * 1024 * 1024).fill(255), 1);
  const blocks = [status(), config(), sps()];
  for (let offset = 0; offset < large.length; offset += 8192)
    blocks.push(large.slice(offset, offset + 8192));
  const mirror = await opened({
    output: async (_id, query) => {
      const after = query.after ?? 0;
      const selected = blocks.slice(after, after + (query.limit ?? 50));
      return {
        data: {
          session: info('running', blocks.length),
          chunks: selected.map((bytes, index) => ({
            sequence: after + index + 1,
            stream: 'stdout',
            bytes,
          })),
          next_sequence: after + selected.length,
        },
        logId: 'large-frame-log',
      };
    },
  });
  await mirror.readOutput({ limit: 100 }, signal());
  assert.equal(mirror.snapshot().packets, 3);
  const received: MirroringPacket[] = [];
  while (mirror.snapshot().cursor < blocks.length)
    received.push(...(await mirror.readPackets({ limit: 100 }, signal())).data.mediaPackets);
  assert.equal(received.length, 1);
  const packet = received[0];
  assert.ok(packet?.kind === 'video');
  assert.equal(packet.bytes.byteLength, 4 * 1024 * 1024);
  assert.equal(packet.bytes.at(-1), 255);
  assert.equal(mirror.snapshot().pendingBytes, 0);
  assert.deepEqual((await mirror.readPackets({}, signal())).data.mediaPackets, []);
  mirror.dispose();
});

test('重连新代清旧媒体配置并以新epoch发送，不复用上一代按键', async () => {
  let reads = 0;
  const sent: number[][] = [];
  const mirror = await opened({
    output: async () => {
      ++reads;
      return {
        data:
          reads === 1
            ? page([status(), config(), sps()])
            : page([frame(5, { state: 'reconnecting', attempt: 1 }, 0, 2), status(2)], 3),
        logId: `output-${reads}`,
      };
    },
    send: async (_id, value) => {
      sent.push([...value]);
      return { data: { id, accepted: true }, logId: 'sent' };
    },
  });
  await mirror.readOutput({}, signal());
  await mirror.sendControl({ type: 'key', action: 'down', keycode: 3 }, signal());
  await mirror.readOutput({}, signal());
  assert.equal(mirror.snapshot().epoch, 2);
  assert.equal(mirror.snapshot().video, null);
  await mirror.sendControl({ type: 'key', action: 'up', keycode: 3 }, signal());
  assert.equal(sent.length, 2);
  const first = sent[0];
  const second = sent[1];
  assert.ok(first);
  assert.ok(second);
  assert.match(new TextDecoder().decode(new Uint8Array(first)), /"epoch":1/);
  assert.match(new TextDecoder().decode(new Uint8Array(second)), /"epoch":2/);
  mirror.dispose();
});

test('取消和销毁及时结束忽略信号的网络等待，旧结果不能写回新选会话', async () => {
  for (const dispose of [false, true]) {
    const delayed = deferred<{ data: SessionOutputPage; logId: string }>();
    const mirror = await opened({ output: () => delayed.promise });
    const controller = new AbortController();
    const waiting = mirror.readOutput({}, controller.signal);
    assert.throws(
      () => mirror.readOutput({}, signal()),
      (error: unknown) => error instanceof ApiError && error.code === 'mirroring_output_busy',
    );
    assert.throws(
      () => mirror.resume(id, signal()),
      (error: unknown) => error instanceof ApiError && error.code === 'mirroring_output_busy',
    );
    if (dispose) mirror.dispose();
    else controller.abort();
    await assert.rejects(waiting, ApiError);
    delayed.resolve({ data: page([status(), config(), sps()]), logId: 'late-log' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(mirror.snapshot().cursor, 0);
    assert.equal(mirror.snapshot().packets, 0);
    mirror.dispose();
  }
  const delayed = deferred<{ data: SessionInfo; logId: string }>();
  let opens = 0;
  const mirror = createMirroringStreaming(
    gateway({
      open: async () =>
        ++opens === 1
          ? delayed.promise
          : { data: info('opening', 0, { generation: 'generation-2' }), logId: 'new-log' },
    }),
  );
  await mirror.refreshDefinitions(signal());
  const old = mirror.open(input, signal());
  await mirror.open(input, signal());
  await assert.rejects(old, ApiError);
  delayed.resolve({ data: info(), logId: 'old-log' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(mirror.snapshot().session?.generation, 'generation-2');
  mirror.dispose();
});

test('截断终态、错身份和错游标均拒绝，帧交付取消禁止自动重放', async () => {
  for (const data of [
    page([config().slice(0, 25)], 0, 'finished'),
    { ...page([config()]), next_sequence: 2 },
    { ...page([config()]), session: info('running', 1, { generation: 'other' }) },
  ]) {
    const mirror = await opened({ output: async () => ({ data, logId: 'invalid-output-log' }) });
    await assert.rejects(
      mirror.readOutput({}, signal()),
      (error: unknown) => error instanceof ApiError && error.logId === 'invalid-output-log',
    );
    mirror.dispose();
  }
  const delayed = deferred<void>();
  const entered = deferred<void>();
  const mirror = createMirroringStreaming(gateway(), {
    sink: {
      packet: () => {
        entered.resolve();
        return delayed.promise;
      },
    },
  });
  await mirror.refreshDefinitions(signal());
  await mirror.open(input, signal());
  const controller = new AbortController();
  const waiting = mirror.readOutput({}, controller.signal);
  await entered.promise;
  controller.abort();
  await assert.rejects(
    waiting,
    (error: unknown) => error instanceof ApiError && error.logId === 'output-log',
  );
  assert.throws(
    () => mirror.resume(id, signal()),
    (error: unknown) =>
      error instanceof ApiError && error.code === 'mirroring_stream_restart_required',
  );
  delayed.resolve();
  mirror.dispose();
});

test('输入收据失败保留不确定状态，EOF只收敛控制而视频继续，取消不假定清理完成', async () => {
  const mirror = await opened({
    output: async (_id, query) => ({
      data: query.after === 0 ? page([status(), config(), sps()]) : page([], query.after),
      logId: 'output-log',
    }),
  });
  await mirror.readOutput({}, signal());
  await mirror.eof(signal());
  assert.equal(mirror.snapshot().inputState, 'eof');
  assert.throws(() => mirror.sendControl({ type: 'rotate' }, signal()), ApiError);
  await mirror.readOutput({}, signal());
  await mirror.cancel(signal());
  assert.equal(mirror.snapshot().session?.status, 'stopping');
  assert.equal(mirror.snapshot().session?.completion, undefined);
  mirror.dispose();
  const failed = await opened({
    send: async () => {
      throw new ApiError('network', 'lost_receipt', '收据丢失', null, 'lost-log');
    },
  });
  await failed.readOutput({}, signal());
  await assert.rejects(failed.sendControl({ type: 'rotate' }, signal()), ApiError);
  assert.equal(failed.snapshot().inputState, 'uncertain');
  assert.equal(failed.snapshot().logs.input, 'lost-log');
  assert.throws(() => failed.sendControl({ type: 'rotate' }, signal()), ApiError);
  failed.dispose();
});

test('释放收到停止中立即撤销本地会话，不轮询服务端终态', async () => {
  let releases = 0;
  let queries = 0;
  const mirror = await opened({
    release: async () => {
      releases++;
      return { data: info('stopping'), logId: 'release-log' };
    },
    get: async () => {
      ++queries;
      throw new ApiError('http', 'not_found', '会话记录不存在', 404, 'query-log');
    },
  });
  const result = await mirror.release(signal());
  assert.equal(releases, 1);
  assert.equal(result.logId, 'release-log');
  assert.equal(result.data.status, 'stopping');
  assert.equal(queries, 0);
  assert.equal(mirror.snapshot().session, null);
  assert.deepEqual(mirror.snapshot().pending, []);
  mirror.dispose();
});

test('HTTP释放请求允许关页后继续发送，已不存在的记录撤销本地选择', async () => {
  let keepalive: boolean | undefined;
  const mirror = createHttpMirroringStreaming(createApiClient({
    baseUrl: 'http://localhost:3000',
    transport: async (request, init) => {
      const path = requestUrl(request).pathname;
      if (path.endsWith('/session-definitions')) return success(definitions, 'definitions-log');
      if (path === '/api/v2/sessions') return success(info(), 'open-log');
      assert.equal(path, `/api/v2/sessions/${id}/release`);
      keepalive = init?.keepalive;
      return new Response(JSON.stringify({
        log_id: 'missing-log', error: { code: 'not_found', message: '会话记录不存在' },
      }), { status: 404, headers: { 'content-type': 'application/json' } });
    },
  }));
  await mirror.refreshDefinitions(signal());
  await mirror.open(input, signal());
  const result = await mirror.release(signal());
  assert.equal(keepalive, true);
  assert.equal(result.logId, 'missing-log');
  assert.equal(mirror.snapshot().session, null);
  mirror.dispose();
});

test('取消打开等待或关闭实例后，迟到的会话会提交释放', async () => {
  for (const dispose of [false, true]) {
    const delayed = deferred<{ data: SessionInfo; logId: string }>();
    const released = deferred<string>();
    let openingSignal: AbortSignal | undefined;
    const mirror = createMirroringStreaming(gateway({
      open: (_, active) => {
        openingSignal = active;
        return delayed.promise;
      },
      release: async (sessionId) => {
        released.resolve(sessionId);
        return { data: info('stopping'), logId: 'late-release-log' };
      },
    }));
    await mirror.refreshDefinitions(signal());
    const controller = new AbortController();
    const waiting = mirror.open(input, controller.signal);
    if (dispose) mirror.dispose();
    else controller.abort();
    await assert.rejects(waiting, ApiError);
    assert.equal(openingSignal?.aborted, false);
    delayed.resolve({ data: info(), logId: 'late-open-log' });
    assert.equal(await released.promise, id);
    assert.equal(mirror.snapshot().session, null);
    mirror.dispose();
  }
});

test('取消释放等待不撤销清理请求，重复释放共用一次提交', async () => {
  const delayed = deferred<{ data: SessionInfo; logId: string }>();
  let releases = 0;
  let releaseSignal: AbortSignal | undefined;
  const mirror = await opened({
    release: (_, active) => {
      releases++;
      releaseSignal = active;
      return delayed.promise;
    },
  });
  const controller = new AbortController();
  const waiting = mirror.release(controller.signal);
  controller.abort();
  await assert.rejects(waiting, ApiError);
  assert.equal(releaseSignal?.aborted, false);
  const continued = mirror.release(signal());
  delayed.resolve({ data: info('finished'), logId: 'release-log' });
  await continued;
  assert.equal(releases, 1);
  assert.equal(mirror.snapshot().session, null);
  mirror.dispose();
});

test('用户释放已结束投屏不被历史清理失败卡住，仍保留原结论和日志', async () => {
  const mirror = await opened({
    release: async () => ({
      data: info('finished', 0, {
        completion: { cleanup: 'unconfirmed', process_exited: false },
      }),
      logId: 'failed-cleanup-log',
    }),
  });
  const released = await mirror.release(signal());
  assert.equal(released.data.completion?.cleanup, 'unconfirmed');
  assert.equal(mirror.snapshot().session, null);
  assert.equal(mirror.snapshot().errors.release?.code, 'mirroring_cleanup_failed');
  assert.equal(mirror.snapshot().errors.release?.logId, 'failed-cleanup-log');
  await mirror.open(input, signal());
  assert.equal(mirror.snapshot().session?.id, id);
  mirror.dispose();
});

for (const releaseStatus of ['running', 'stopping'] as const) {
  test(`兼容投屏释放 HTTP 202 返回 ${releaseStatus} 停止画面输入，旧轮询不能回写新会话`, { timeout: 3000 }, async (t) => {
    const delayed = deferred<{ data: SessionOutputPage; logId: string }>();
    const entered = deferred<void>();
    let resets = 0;
    let queries = 0;
    const http = createHttpSessionGateway(createApiClient({ baseUrl: 'http://localhost',
      transport: async (request, init) => {
        assert.equal(requestUrl(request).pathname, `/api/v2/sessions/${id}/release`);
        assert.equal(init?.method, 'POST');
        return success(info(releaseStatus), 'accepted-release-log', 202);
      },
    }));
    const mirror = createMirroringStreaming(gateway({
      output: () => { entered.resolve(); return delayed.promise; },
      release: http.release,
      get: async () => { ++queries; throw new Error('不应查询旧会话终态'); },
    }), { sink: { packet: () => { throw new Error('旧画面不得交付'); }, reset: () => { ++resets; } } });
    t.after(() => mirror.dispose());
    await mirror.refreshDefinitions(signal());
    await mirror.open(input, signal());
    const polling = assert.rejects(mirror.pollOutput({}, signal()), ApiError);
    await entered.promise;
    const before = resets;
    const result = await mirror.release(signal());
    await polling;
    assert.equal(result.data.status, releaseStatus);
    assert.equal(queries, 0);
    assert.equal(resets, before + 1);
    assert.equal(mirror.snapshot().session, null);
    assert.equal(mirror.snapshot().status, null);
    assert.deepEqual(mirror.snapshot().pending, []);
    assert.throws(() => mirror.sendControl({ type: 'rotate' }, signal()), ApiError);
    await mirror.open(input, signal());
    const current = mirror.snapshot();
    delayed.resolve({ data: page([status(), config(), sps()]), logId: 'old-poll-log' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(mirror.snapshot(), current);
  });
}

for (const fails of [false, true]) {
  test(`兼容投屏旧释放晚到${fails ? '失败' : '成功'}不覆盖新会话或清除新释放任务`, async (t) => {
    const old = deferred<{ data: SessionInfo; logId: string }>();
    const current = deferred<{ data: SessionInfo; logId: string }>();
    let releases = 0;
    let oldReleaseSignal: AbortSignal | undefined;
    const mirror = await opened({ release: (_, active) => {
      if (++releases === 1) { oldReleaseSignal = active; return old.promise; }
      return current.promise;
    } });
    t.after(() => mirror.dispose());
    const oldWaiting = assert.rejects(mirror.release(signal()), ApiError);
    await mirror.open(input, signal());
    await oldWaiting;
    assert.equal(oldReleaseSignal?.aborted, false);
    const releasing = mirror.release(signal());
    if (fails) old.reject(new ApiError('http', 'old_release_failed', '旧释放失败', 500, 'old-error-log'));
    else old.resolve({ data: info('finished'), logId: 'old-release-log' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const duplicate = mirror.release(signal());
    assert.equal(releases, 2);
    current.resolve({ data: info('stopping'), logId: 'new-release-log' });
    await Promise.all([releasing, duplicate]);
    assert.equal(mirror.snapshot().logs.release, 'new-release-log');
    assert.equal(mirror.snapshot().errors.release, undefined);
    assert.equal(mirror.snapshot().session, null);
  });
}

test('兼容投屏释放失败保留原始错误与日志，不伪造清理成功', async (t) => {
  const original = new ApiError('http', 'release_failed', '原始释放失败', 503, 'original-release-log');
  const mirror = await opened({ release: async () => { throw original; } });
  t.after(() => mirror.dispose());
  await assert.rejects(mirror.release(signal()), (error: unknown) => error === original);
  assert.equal(mirror.snapshot().errors.release, original);
  assert.equal(mirror.snapshot().logs.release, 'original-release-log');
  assert.equal(mirror.snapshot().session?.id, id);
  assert.deepEqual(mirror.snapshot().pending, []);
});
