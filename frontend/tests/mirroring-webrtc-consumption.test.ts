import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebRtcMirroring } from '../src/features/mirroring-streaming/index.ts';
import { createWebRtcSignalDecoder, encodeWebRtcAnswer, encodeWebRtcControl } from '../src/features/mirroring-streaming/services/webrtc-signaling.ts';
import { ApiError } from '../src/services/api/index.ts';
import type { SessionGateway, SessionInfo, SessionOutputPage } from '../src/services/api/index.ts';
import { FakeMediaStream, FakeMediaTrack, FakeWebRtcConnection } from './webrtc-fixtures.ts';

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
