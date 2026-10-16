import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebRtcMirroring } from '../src/features/mirroring-streaming/index.ts';
import type { MirroringStreamInput } from '../src/features/mirroring-streaming/index.ts';
import { createWebRtcSignalDecoder, encodeWebRtcAnswer, encodeWebRtcControl } from '../src/features/mirroring-streaming/services/webrtc-signaling.ts';
import { ApiError } from '../src/services/api/index.ts';
import type { SessionGateway, SessionInfo, SessionOutputPage } from '../src/services/api/index.ts';
import { FakeControlChannel, FakeMediaStream, FakeMediaTrack, FakeWebRtcConnection } from './webrtc-fixtures.ts';

const sessionId = '12345678-1234-1234-1234-123456789abc';
const operation = 'plugin.mirroring.open_webrtc';
const encoder = new TextEncoder();
const signal = () => new AbortController().signal;
const definitions = {
  revision: 1,
  sessions: [{
    id: operation, title: 'WebRTC 投屏', input_schema: { type: 'object' },
    execution: { api_version: 1, source: 'declared', total_timeout_ms: 3600000 },
  }],
};
function info(status: SessionInfo['status'] = 'running', outputSequence = 0): SessionInfo {
  return {
    id: sessionId, operation, plugin_id: 'mirroring', generation: 'generation-1',
    created_at: 1, status, output_sequence: outputSequence,
    ...(status === 'finished' ? { completion: { cleanup: 'complete' as const, process_exited: true } } : {}),
  };
}
function page(chunks: readonly number[][], after = 0): SessionOutputPage {
  return {
    session: info('running', after + chunks.length),
    chunks: chunks.map((bytes, index) => ({ sequence: after + index + 1, stream: 'stdout', bytes })),
    next_sequence: after + chunks.length,
  };
}
function gateway(changes: Partial<SessionGateway> = {}): SessionGateway {
  return {
    definitions: async () => ({ data: definitions, logId: 'definitions-log' }),
    list: async () => ({ data: [], logId: null }),
    open: async () => ({ data: info(), logId: 'open-log' }),
    get: async () => ({ data: info('finished'), logId: 'get-log' }),
    output: async () => ({ data: page([]), logId: 'output-log' }),
    send: async () => ({ data: { id: sessionId, accepted: true }, logId: 'input-log' }),
    eof: async () => ({ data: { id: sessionId, accepted: true }, logId: null }),
    cancel: async () => ({ data: info('stopping'), logId: null }),
    release: async () => ({ data: info('finished'), logId: 'release-log' }),
    remove: async () => ({ data: { id: sessionId }, logId: null }),
    ...changes,
  };
}

const clientId = '12345678-1234-4234-8234-123456789abc';
const otherId = '12345678-1234-4234-8234-123456789def';
function ownership(revision: number, hasControl: boolean, controlRevision = revision) {
  return JSON.stringify({ version: 1, type: 'control_state', epoch: 1, revision, control_revision: controlRevision,
    client_id: clientId, owner_id: hasControl ? clientId : otherId, is_master: false,
    can_control: true, has_control: hasControl, transitioning: false, blocked: false, requests: [] });
}

async function openedMirror(input: Partial<MirroringStreamInput> = {}, automaticReceipt = true) {
  const channels: FakeControlChannel[] = [];
  const messages = [
    { version: 1, epoch: 1, type: 'offer', sdp: 'offer' },
    { version: 1, epoch: 1, type: 'status', state: 'streaming' },
  ];
  const offer = [...encoder.encode(messages.map((message) => `${JSON.stringify(message)}\n`).join(''))];
  const mirror = createWebRtcMirroring(gateway({
    output: async (_id, query) => ({
      data: query.after === 0 ? page([offer]) : { ...page([], 1), session: info('running', 1) },
      logId: 'output-log',
    }),
  }), {
    connectionFactory: () => {
      const connection = new FakeWebRtcConnection();
      connection.setLocalDescription = async () => {
        queueMicrotask(() => {
          const channel = new FakeControlChannel();
          channel.send = (message) => {
            channel.sent.push(message);
            const command: unknown = JSON.parse(message);
            if (automaticReceipt && command !== null && typeof command === 'object' &&
              'request_id' in command && typeof command.request_id === 'string') {
              queueMicrotask(() => channel.emitMessage(JSON.stringify({ version: 1, epoch: 1,
                type: 'control_result', request_id: command.request_id, ok: true })));
            }
          };
          channels.push(channel);
          connection.emitTrack(new FakeMediaTrack());
          connection.emitChannel(channel);
          channel.readyState = 'open';
          channel.changed();
          connection.setState('connected');
        });
      };
      return connection;
    },
    mediaStreamFactory: () => new FakeMediaStream(),
  });
  await mirror.refreshDefinitions(signal());
  await mirror.open({ device_id: 'emulator-5554', control: true, clipboard_autosync: true, ...input }, signal());
  const channel = channels[0];
  if (!channel) throw new Error('WebRTC 控制通道未创建');
  return { mirror, channel };
}

test('WebRTC 信令跨块解析且严格拒绝错误代次与过长行', () => {
  const decoder = createWebRtcSignalDecoder();
  const line = [...encoder.encode(`${JSON.stringify({ version: 1, epoch: 1, type: 'offer', sdp: '测试🙂' })}\n`)];
  assert.deepEqual(decoder.push(line.slice(0, 25)), []);
  assert.deepEqual(decoder.push(line.slice(25)), [{ type: 'offer', sdp: '测试🙂' }]);
  decoder.finish();
  assert.throws(() => createWebRtcSignalDecoder().push([...encoder.encode('{"version":1,"epoch":2,"type":"status","state":"streaming"}\n')]));
  assert.throws(() => createWebRtcSignalDecoder().push(new Array<number>(65537).fill(32)));
  assert.equal(encodeWebRtcAnswer('answer').at(-1), 10);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(new Uint8Array(encodeWebRtcControl({ type: 'rotate' })))),
    { version: 1, epoch: 1, type: 'control', command: { type: 'rotate' } });
  assert.deepEqual(JSON.parse(new TextDecoder().decode(new Uint8Array(encodeWebRtcControl({ type: 'rotate' }, 1, 3)))),
    { version: 1, epoch: 1, type: 'control', command: { type: 'rotate' }, control_revision: 3 });
  assert.throws(() => encodeWebRtcControl({ type: 'rotate' }, 1, 0));
});

test('WebRTC 模型只在控制与剪贴板自动同步均启用时发布完整回传', async () => {
  let connection: FakeWebRtcConnection | null = null;
  let channel: FakeControlChannel | null = null;
  const offer = [...encoder.encode(`${JSON.stringify({ version: 1, epoch: 1, type: 'offer', sdp: 'offer' })}\n`)];
  const mirror = createWebRtcMirroring(gateway({
    output: async (_id, query) => ({
      data: query.after === 0 ? page([offer]) : { ...page([], 1), session: info('running', 1) },
      logId: 'output-log',
    }),
  }), {
    connectionFactory: () => {
      connection = new FakeWebRtcConnection();
      connection.setLocalDescription = async () => {
        queueMicrotask(() => {
          if (!connection) return;
          connection.emitTrack(new FakeMediaTrack());
          channel = new FakeControlChannel();
          connection.emitChannel(channel);
          channel.readyState = 'open';
          channel.changed();
          connection.setState('connected');
        });
      };
      return connection;
    },
    mediaStreamFactory: () => new FakeMediaStream(),
  });
  await mirror.refreshDefinitions(signal());
  await mirror.open({ device_id: 'emulator-5554', control: true, clipboard_autosync: true }, signal());
  const currentChannel = channel as FakeControlChannel | null;
  if (currentChannel === null) throw new Error('WebRTC 控制通道未创建');
  currentChannel.emitMessage(JSON.stringify({ version: 1, type: 'clipboard', epoch: 1, sequence: 1, part: 0, total: 1, text: '设备剪贴板' }));
  assert.equal(mirror.snapshot().clipboard?.text, '设备剪贴板');
  assert.equal(mirror.snapshot().clipboard?.sequence, 1);
  await mirror.release(signal());
  assert.equal(mirror.snapshot().clipboard, null);
  mirror.dispose();
});

test('WebRTC 归属撤销立即清剪贴板并拒绝设备输入，但允许申请响应抢回及释放控制', async () => {
  const { mirror, channel } = await openedMirror();
  await assert.rejects(mirror.sendControl({ type: 'rotate' }, signal()),
    { code: 'mirroring_webrtc_ownership_unconfirmed' });
  channel.emitMessage(ownership(1, true));
  await mirror.sendControl({ type: 'rotate' }, signal());
  assert.deepEqual(JSON.parse(channel.sent.at(-1) ?? ''),
    { version: 1, epoch: 1, type: 'control', command: { type: 'rotate' }, control_revision: 1 });
  channel.emitMessage(ownership(2, false));
  assert.equal(mirror.snapshot().ownership?.hasControl, false);
  await assert.rejects(mirror.sendControl({ type: 'rotate' }, signal()),
    { code: 'mirroring_webrtc_control_not_owner' });
  const sentBefore = channel.sent.length;
  await mirror.requestControl(signal());
  await mirror.respondControl(otherId, true, signal());
  await mirror.respondControl(otherId, false, signal());
  await mirror.reclaimControl(signal());
  await mirror.releaseControl(signal());
  const ownershipCommands = channel.sent.slice(sentBefore).map((message) => {
    const { request_id, ...command }: { request_id: string; [key: string]: unknown } = JSON.parse(message);
    assert.match(request_id, /^[0-9a-f-]{36}$/i);
    return command;
  });
  assert.deepEqual(ownershipCommands, [
    { version: 1, epoch: 1, type: 'control_request' },
    { version: 1, epoch: 1, type: 'control_respond', client_id: otherId, accept: true },
    { version: 1, epoch: 1, type: 'control_respond', client_id: otherId, accept: false },
    { version: 1, epoch: 1, type: 'control_reclaim' },
    { version: 1, epoch: 1, type: 'control_release' },
  ]);
  assert.equal(channel.sent.slice(sentBefore).every((message) => message.endsWith('\n')), true);
  await assert.rejects(mirror.respondControl('无效客户端', true, signal()),
    { code: 'mirroring_webrtc_ownership_invalid' });
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(mirror.requestControl(cancelled.signal), { code: 'cancelled' });
  channel.emitMessage(ownership(3, true));
  await mirror.sendControl({ type: 'rotate' }, signal());
  channel.emitMessage(JSON.stringify({ version: 1, type: 'clipboard', epoch: 1,
    sequence: 1, part: 0, total: 1, text: '控制者原生复制', control_revision: 3 }));
  assert.deepEqual(mirror.snapshot().clipboard, { text: '控制者原生复制', sequence: 1, controlRevision: 3 });
  channel.emitMessage(ownership(4, true, 3));
  assert.deepEqual(mirror.snapshot().clipboard, { text: '控制者原生复制', sequence: 1, controlRevision: 3 });
  await mirror.sendControl({ type: 'key', action: 'up', keycode: 51 }, signal());
  assert.deepEqual(JSON.parse(channel.sent.at(-1) ?? ''), { version: 1, epoch: 1, type: 'control',
    command: { type: 'key', action: 'up', keycode: 51 }, control_revision: 3 });
  channel.emitMessage(ownership(5, false, 4));
  assert.equal(mirror.snapshot().clipboard, null);
  channel.emitMessage(JSON.stringify({ version: 1, type: 'clipboard', epoch: 1,
    sequence: 2, part: 0, total: 1, text: '迟到正文', control_revision: 3 }));
  assert.equal(mirror.snapshot().clipboard, null);
  await mirror.release(signal());
  assert.equal(mirror.snapshot().ownership, null);
  await assert.rejects(mirror.requestControl(signal()), { code: 'mirroring_webrtc_control_unavailable' });
  await mirror.dispose();
});

test('WebRTC 控制申请等待对应回执，拒绝取消关闭不改变所有权或中断观看', async () => {
  const { mirror, channel } = await openedMirror({}, false);
  channel.emitMessage(ownership(1, false));
  let resolved = false;
  const requested = mirror.requestControl(signal()).then(() => { resolved = true; });
  const request: unknown = JSON.parse(channel.sent.at(-1) ?? '');
  assert.ok(request !== null && typeof request === 'object' && 'request_id' in request &&
    typeof request.request_id === 'string');
  await Promise.resolve();
  assert.equal(resolved, false);
  channel.emitMessage(JSON.stringify({ version: 1, epoch: 1, type: 'control_result',
    request_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ok: true }));
  await Promise.resolve();
  assert.equal(resolved, false);
  const rejected = assert.rejects(requested, { code: 'mirroring_webrtc_control_rejected', message: '当前控制者不存在' });
  channel.emitMessage(JSON.stringify({ version: 1, epoch: 1, type: 'control_result',
    request_id: request.request_id, ok: false, error: '当前控制者不存在' }));
  await rejected;
  assert.equal(mirror.snapshot().ownership?.hasControl, false);
  assert.equal(mirror.snapshot().session?.status, 'running');
  assert.equal(mirror.snapshot().stream?.getVideoTracks().length, 1);
  const cancelled = new AbortController();
  const waiting = mirror.requestControl(cancelled.signal);
  const cancellation = assert.rejects(waiting, { code: 'cancelled' });
  cancelled.abort();
  await cancellation;
  const closing = mirror.requestControl(signal());
  const closed = assert.rejects(closing, { code: 'mirroring_webrtc_closed' });
  await mirror.release(signal());
  await closed;
  await mirror.dispose();
});

test('WebRTC 控制申请五秒未回执明确超时，迟到成功不恢复已经结束的等待', async (context) => {
  const { mirror, channel } = await openedMirror({}, false);
  context.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const requested = mirror.requestControl(signal());
    const timeout = assert.rejects(requested, { code: 'mirroring_webrtc_control_timeout' });
    const request: unknown = JSON.parse(channel.sent.at(-1) ?? '');
    assert.ok(request !== null && typeof request === 'object' && 'request_id' in request);
    context.mock.timers.tick(5000);
    await timeout;
    channel.emitMessage(JSON.stringify({ version: 1, epoch: 1, type: 'control_result',
      request_id: request.request_id, ok: true }));
    assert.equal(mirror.snapshot().errors.ownership?.code, 'mirroring_webrtc_control_timeout');
    assert.equal(mirror.snapshot().session?.status, 'running');
  } finally {
    context.mock.timers.reset();
    await mirror.dispose();
  }
});

test('局域网 HTTP 缺少 crypto.randomUUID 时仍用安全随机 UUID 完成申请和批准', async () => {
  const { mirror, channel } = await openedMirror();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const secureCrypto = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {
    getRandomValues: secureCrypto.getRandomValues.bind(secureCrypto),
  } });
  try {
    assert.equal(globalThis.crypto.randomUUID, undefined);
    await mirror.requestControl(signal());
    await mirror.respondControl(otherId, true, signal());
    const requests = channel.sent.map((value) => {
      const message: unknown = JSON.parse(value);
      assert.ok(message !== null && typeof message === 'object' && 'request_id' in message &&
        typeof message.request_id === 'string' && 'type' in message);
      assert.match(message.request_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      return { id: message.request_id, type: message.type };
    });
    assert.deepEqual(requests.map((request) => request.type), ['control_request', 'control_respond']);
    assert.equal(new Set(requests.map((request) => request.id)).size, 2);
    assert.equal(mirror.snapshot().session?.status, 'running');
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
    else Reflect.deleteProperty(globalThis, 'crypto');
    await mirror.dispose();
  }
});

test('WebRTC 仅观看实例仍收到所有权信息，控制功能关闭时禁止申请或接管', async () => {
  const { mirror, channel } = await openedMirror({ control: false, clipboard_autosync: false });
  channel.emitMessage(JSON.stringify({ version: 1, type: 'control_state', epoch: 1, revision: 1, control_revision: 1,
    client_id: clientId, owner_id: otherId, is_master: false, can_control: false,
    has_control: false, transitioning: false, blocked: false, requests: [] }));
  assert.equal(mirror.snapshot().ownership?.canControl, false);
  await assert.rejects(mirror.requestControl(signal()), { code: 'mirroring_webrtc_control_unavailable' });
  await assert.rejects(mirror.reclaimControl(signal()), { code: 'mirroring_webrtc_control_unavailable' });
  await assert.rejects(mirror.releaseControl(signal()), { code: 'mirroring_webrtc_control_unavailable' });
  assert.equal(channel.sent.length, 0);
  await mirror.dispose();
});

test('WebRTC 完整 answer 按 8192 字节拆片，释放去重并确认清理', async () => {
  const sent: number[][] = [];
  let releases = 0;
  let outputCalls = 0;
  const videoTrack = new FakeMediaTrack();
  const line = [...encoder.encode(`${JSON.stringify({ version: 1, epoch: 1, type: 'offer', sdp: 'offer' })}\n`)];
  const mirror = createWebRtcMirroring(gateway({
    output: async (_id, query) => {
      ++outputCalls;
      return { data: query.after === 0 ? page([line.slice(0, 15), line.slice(15)]) :
        { ...page([], 2), session: info('running', 2) }, logId: 'output-log' };
    },
    send: async (_id, bytes) => {
      sent.push([...bytes]);
      return { data: { id: sessionId, accepted: true }, logId: 'input-log' };
    },
    release: async () => {
      ++releases;
      return { data: info('finished'), logId: 'release-log' };
    },
  }), {
    mediaStreamFactory: () => new FakeMediaStream(),
    connectionFactory: () => {
      const connection = new FakeWebRtcConnection();
      connection.localDescription = { sdp: 'a'.repeat(12000) };
      connection.setLocalDescription = async () => {
        queueMicrotask(() => {
          connection.emitTrack(videoTrack);
          connection.setState('connected');
        });
      };
      return connection;
    },
  });
  await mirror.refreshDefinitions(signal());
  const opened = await mirror.open({ device_id: 'emulator-5554', control: false }, signal());
  assert.equal(opened.data.id, sessionId);
  assert.equal(mirror.snapshot().inputState, 'writable');
  assert.equal(sent.length, 2);
  assert.ok(sent.every((bytes) => bytes.length <= 8192));
  assert.equal(outputCalls > 0, true);
  assert.equal(mirror.snapshot().logs.answer, 'input-log');
  const nested: { task?: ReturnType<typeof mirror.release> } = {};
  const unsubscribe = mirror.subscribe((view) => {
    if (view.releasing && !nested.task) nested.task = mirror.release(signal());
  });
  await Promise.all([mirror.release(signal()), mirror.release(signal())]);
  assert.ok(nested.task);
  await nested.task;
  unsubscribe();
  assert.equal(releases, 1);
  assert.equal(mirror.snapshot().session, null);
  await mirror.dispose();
});

test('取消打开后晚到已接受会话触发独立释放，不复活本地快照', async () => {
  const late: { resolve?: (value: { data: SessionInfo; logId: string }) => void } = {};
  let releases = 0;
  const mirror = createWebRtcMirroring(gateway({
    open: () => new Promise((resolve) => { late.resolve = resolve; }),
    release: async () => {
      ++releases;
      return { data: info('finished'), logId: 'release-log' };
    },
  }));
  await mirror.refreshDefinitions(signal());
  const controller = new AbortController();
  const pending = mirror.open({ device_id: 'emulator-5554' }, controller.signal);
  controller.abort();
  await assert.rejects(pending);
  assert.equal(mirror.snapshot().session, null);
  late.resolve?.({ data: info(), logId: 'late-open-log' });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(releases, 1);
  assert.equal(mirror.snapshot().session, null);
  await mirror.dispose();
});

test('自然完成且清理成功后可重开，清理失败则保留会话身份', async () => {
  const offer = [...encoder.encode(`${JSON.stringify({ version: 1, epoch: 1, type: 'offer', sdp: 'offer' })}\n`)];
  let opens = 0;
  let finish = false;
  const mirror = createWebRtcMirroring(gateway({
    open: async () => {
      ++opens;
      finish = false;
      return { data: info('running'), logId: 'open-log' };
    },
    output: async (_id, query) => {
      if (query.after === 0) return { data: page([offer]), logId: 'offer-log' };
      if (!finish) return { data: page([], 1), logId: 'poll-log' };
      const cleanup = opens === 1 ? 'complete' as const : 'failed' as const;
      return { data: { ...page([], 1), session: {
        ...info('finished', 1), completion: {
          cleanup, process_exited: true,
          ...(opens === 1 ? {
            failure: { code: 'device_failed', message: '设备结束失败' },
            outcome: { artifacts: [], error: '直播处理失败' },
          } : {}),
        },
      } }, logId: 'finish-log' };
    },
    release: async () => {
      if (opens === 1) throw new ApiError('http', 'not_found', '会话已移除', 404);
      return { data: info('finished'), logId: 'release-log' };
    },
  }), {
    connectionFactory: () => {
      const connection = new FakeWebRtcConnection();
      connection.setLocalDescription = async () => {
        queueMicrotask(() => {
          connection.emitTrack(new FakeMediaTrack());
          connection.setState('connected');
        });
      };
      return connection;
    },
    mediaStreamFactory: () => new FakeMediaStream(),
  });
  await mirror.refreshDefinitions(signal());
  await mirror.open({ device_id: 'emulator-5554', control: false }, signal());
  const completed = new Promise<void>((resolve) => {
    const unsubscribe = mirror.subscribe((view) => {
      if (view.session !== null) return;
      unsubscribe();
      resolve();
    });
  });
  finish = true;
  await completed;
  assert.equal(mirror.snapshot().session, null);
  assert.equal(mirror.snapshot().errors.output?.code, 'mirroring_webrtc_session_failed');
  assert.match(mirror.snapshot().errors.output?.message ?? '', /设备结束失败.*直播处理失败/);
  const removed = await mirror.release(signal());
  assert.equal(removed.data.completion?.cleanup, 'complete');
  await mirror.open({ device_id: 'emulator-5554', control: false }, signal());
  const failed = new Promise<void>((resolve) => {
    const unsubscribe = mirror.subscribe((view) => {
      if (view.session?.status !== 'finished') return;
      unsubscribe();
      resolve();
    });
  });
  finish = true;
  await failed;
  assert.equal(mirror.snapshot().session?.status, 'finished');
  assert.equal(mirror.snapshot().errors.output?.code, 'mirroring_webrtc_cleanup_failed');
  await mirror.dispose();
});
