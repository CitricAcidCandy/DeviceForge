import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebRtcPeer } from '../src/features/mirroring-streaming/services/webrtc.ts';
import type { MirroringOwnership } from '../src/features/mirroring-streaming/index.ts';
import type { WebRtcOwnershipResult } from '../src/features/mirroring-streaming/services/webrtc-ownership.ts';
import { FakeControlChannel, FakeMediaStream, FakeMediaTrack, FakeWebRtcConnection } from './webrtc-fixtures.ts';

function fixture(clipboard = false, ownership = false) {
  const connection = new FakeWebRtcConnection();
  const stream = new FakeMediaStream();
  const track = new FakeMediaTrack();
  const channel = new FakeControlChannel();
  const errors: string[] = [];
  const received: string[] = [];
  const revisions: (number | undefined)[] = [];
  const states: MirroringOwnership[] = [];
  const results: WebRtcOwnershipResult[] = [];
  let active = true;
  const peer = createWebRtcPeer({
    connectionFactory: () => connection,
    mediaStreamFactory: () => stream,
    audio: false,
    active: () => active,
    onStream: () => {},
    onControlReady: () => {},
    onFailure: (error) => { errors.push(error.code); },
    ...(clipboard ? { onClipboard: (text: string, revision?: number) => {
      received.push(text);
      revisions.push(revision);
    } } : {}),
    ...(ownership ? { onOwnership: (state: MirroringOwnership) => { states.push(state); } } : {}),
    ...(ownership ? { onOwnershipResult: (result: WebRtcOwnershipResult) => { results.push(result); } } : {}),
  });
  return { peer, connection, stream, track, channel, errors, received, revisions, states, results,
    deactivate: () => { active = false; } };
}

test('WebRTC 控制仅在可靠有序通道与媒体连接均就绪后发送，背压明确拒绝', async () => {
  const setup = fixture();
  const waiting = setup.peer.waitForReady(new AbortController().signal, true);
  setup.connection.emitTrack(setup.track);
  setup.connection.emitChannel(setup.channel);
  assert.throws(() => setup.peer.sendControl([1, 2]));
  setup.connection.setState('connected');
  assert.throws(() => setup.peer.sendControl([1, 2]));
  setup.channel.readyState = 'open';
  setup.channel.changed();
  await waiting;
  setup.peer.sendControl([1, 2]);
  assert.equal(setup.channel.sent[0], '\u0001\u0002');
  setup.channel.bufferedAmount = 65537;
  assert.throws(() => setup.peer.sendControl([3]), { code: 'mirroring_webrtc_control_backpressure' });
  setup.peer.close();
  assert.deepEqual({ channel: setup.channel.closed, peer: setup.connection.closed, track: setup.track.stopCount },
    { channel: 1, peer: 1, track: 1 });
});

test('WebRTC 撤销后迟到轨道立即停止，ICE 等待取消清除监听', async () => {
  const setup = fixture();
  setup.deactivate();
  setup.connection.emitTrack(setup.track);
  assert.equal(setup.track.stopCount, 1);
  setup.peer.close();

  const ice = fixture();
  ice.connection.iceGatheringState = 'gathering';
  const controller = new AbortController();
  const pending = ice.peer.answer('offer', controller.signal);
  await Promise.resolve();
  await Promise.resolve();
  controller.abort();
  await assert.rejects(pending);
  assert.equal(ice.connection.iceListenerCount, 0);
  ice.peer.close();
});

function clipboard(text: string, part = 0, total = 1, sequence = 1, controlRevision?: number): string {
  return JSON.stringify({ version: 1, type: 'clipboard', epoch: 1, sequence, part, total, text,
    ...(controlRevision === undefined ? {} : { control_revision: controlRevision }),
  });
}

const clientId = '12345678-1234-4234-8234-123456789abc';
const otherId = '12345678-1234-4234-8234-123456789def';
function ownership(overrides: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({ version: 1, type: 'control_state', epoch: 1, revision: 1, control_revision: 1,
    client_id: clientId, owner_id: clientId, is_master: true, can_control: true,
    has_control: true, transitioning: false, blocked: false, requests: [], ...overrides });
}

test('WebRTC 剪贴板分片收齐后才发布，空文本有效且关闭撤销消息监听', () => {
  const setup = fixture(true);
  setup.connection.emitChannel(setup.channel);
  setup.channel.emitMessage(clipboard('中文🙂', 0, 2));
  assert.deepEqual(setup.received, []);
  setup.channel.emitMessage(clipboard('完成', 1, 2));
  setup.channel.emitMessage(clipboard('', 0, 1, 2));
  assert.deepEqual(setup.received, ['中文🙂完成', '']);
  assert.equal(setup.channel.messageListenerCount, 1);
  setup.peer.close();
  assert.equal(setup.channel.messageListenerCount, 0);
  setup.channel.emitMessage(clipboard('晚到', 0, 1, 3));
  assert.deepEqual(setup.received, ['中文🙂完成', '']);
});

test('WebRTC 剪贴板严格拒绝错误代次、字段、UTF8边界与乱序，不输出正文', () => {
  for (const data of [
    '{', new Uint8Array([255]),
    JSON.stringify({ version: 1, type: 'clipboard', epoch: 2, sequence: 1, part: 0, total: 1, text: 'private' }),
    JSON.stringify({ version: 1, type: 'clipboard', epoch: 1, sequence: 1, part: 0, total: 1, text: 'private', extra: true }),
    clipboard('\0'), clipboard('\ud800'), clipboard('a'.repeat(8193)), clipboard('private', 1, 2),
    clipboard('private', 0, 34),
  ]) {
    const setup = fixture(true);
    setup.connection.emitChannel(setup.channel);
    setup.channel.emitMessage(data);
    assert.deepEqual(setup.received, []);
    assert.deepEqual(setup.errors, ['mirroring_webrtc_clipboard_invalid']);
    setup.peer.close();
  }
  for (const invalid of [clipboard('乱序', 0, 1, 2), clipboard('乱序', 0, 2), clipboard('乱序', 1, 3)]) {
    const setup = fixture(true);
    setup.connection.emitChannel(setup.channel);
    setup.channel.emitMessage(clipboard('首块', 0, 2));
    setup.channel.emitMessage(invalid);
    assert.deepEqual(setup.received, []);
    assert.deepEqual(setup.errors, ['mirroring_webrtc_clipboard_invalid']);
    setup.peer.close();
  }
});

test('WebRTC 未启用剪贴板或旧代撤销时不处理设备回传', () => {
  const disabled = fixture();
  disabled.connection.emitChannel(disabled.channel);
  disabled.channel.emitMessage('{');
  assert.deepEqual(disabled.errors, []);
  disabled.peer.close();
  const stale = fixture(true);
  stale.connection.emitChannel(stale.channel);
  stale.deactivate();
  stale.channel.emitMessage(clipboard('旧代'));
  assert.deepEqual(stale.received, []);
  stale.peer.close();
});

test('WebRTC 未启用剪贴板仍消费控制归属，严格映射当前控制者与申请队列', () => {
  const setup = fixture(false, true);
  setup.connection.emitChannel(setup.channel);
  setup.channel.emitMessage(ownership({ requests: [{ client_id: otherId, is_master: false }] }));
  assert.deepEqual(setup.states, [{ revision: 1, controlRevision: 1, clientId, ownerId: clientId,
    isMaster: true, canControl: true, hasControl: true, transitioning: false, blocked: false,
    requests: [{ clientId: otherId, isMaster: false }],
  }]);
  assert.equal(Object.isFrozen(setup.states[0]), true);
  setup.channel.emitMessage(ownership({ revision: 2, owner_id: otherId, has_control: false }));
  setup.channel.emitMessage(ownership());
  assert.equal(setup.states.length, 2);
  assert.equal(setup.states.at(-1)?.hasControl, false);
  assert.deepEqual(setup.errors, []);
  setup.peer.close();
});

test('WebRTC 控制归属严格拒绝无界修订、错误身份、冲突字段及重复申请', () => {
  for (const overrides of [
    { revision: 0 }, { revision: Number.MAX_SAFE_INTEGER + 1 }, { revision: 1.5 },
    { control_revision: 0 }, { control_revision: Number.MAX_SAFE_INTEGER + 1 },
    { client_id: '非法身份' }, { owner_id: 1 }, { is_master: 1 }, { can_control: false },
    { has_control: 'true' }, { transitioning: true }, { blocked: true }, { extra: true },
    { owner_id: otherId }, { owner_id: null },
    { requests: [{ client_id: otherId, is_master: 'false' }] },
    { requests: [{ client_id: otherId, is_master: false }, { client_id: otherId, is_master: false }] },
    { requests: new Array<unknown>(65).fill({ client_id: otherId, is_master: false }) },
  ]) {
    const setup = fixture(false, true);
    setup.connection.emitChannel(setup.channel);
    setup.channel.emitMessage(ownership(overrides));
    assert.deepEqual(setup.states, []);
    assert.deepEqual(setup.errors, ['mirroring_webrtc_ownership_invalid']);
    setup.peer.close();
  }
  const setup = fixture(false, true);
  setup.connection.emitChannel(setup.channel);
  setup.channel.emitMessage(ownership());
  setup.channel.emitMessage(ownership({ revision: 2, client_id: otherId, owner_id: otherId }));
  assert.equal(setup.states.length, 1);
  assert.deepEqual(setup.errors, ['mirroring_webrtc_ownership_invalid']);
  setup.peer.close();
});

test('WebRTC 原生剪贴板只接收本方控制修订，撤销清分片且旧修订不导致连接失败', () => {
  const setup = fixture(true, true);
  setup.connection.emitChannel(setup.channel);
  setup.channel.emitMessage(ownership());
  setup.channel.emitMessage(clipboard('无修订旧协议'));
  setup.channel.emitMessage(clipboard('错误修订', 0, 1, 1, 2));
  setup.channel.emitMessage(clipboard('尚未完成', 0, 2, 1, 1));
  setup.channel.emitMessage(ownership({ revision: 2, control_revision: 2, owner_id: otherId, has_control: false }));
  setup.channel.emitMessage(clipboard('旧分片', 1, 2, 1, 1));
  setup.channel.emitMessage(clipboard('他人控制时正文', 0, 1, 2, 2));
  assert.deepEqual(setup.received, []);
  setup.channel.emitMessage(ownership({ revision: 3, control_revision: 3 }));
  setup.channel.emitMessage(clipboard('本方新修订', 0, 2, 1, 3));
  setup.channel.emitMessage(clipboard('旧修订插入正文', 0, 1, 2, 1));
  setup.channel.emitMessage(clipboard('完整正文', 1, 2, 1, 3));
  assert.deepEqual(setup.received, ['本方新修订完整正文']);
  assert.deepEqual(setup.revisions, [3]);
  assert.deepEqual(setup.errors, []);
  setup.peer.close();
});

test('WebRTC 普通申请更新状态修订但不撤销正在接收的控制修订剪贴板', () => {
  const setup = fixture(true, true);
  setup.connection.emitChannel(setup.channel);
  setup.channel.emitMessage(ownership());
  setup.channel.emitMessage(clipboard('申请前半段', 0, 2, 1, 1));
  setup.channel.emitMessage(ownership({ revision: 2,
    requests: [{ client_id: otherId, is_master: false }] }));
  setup.channel.emitMessage(clipboard('申请后半段', 1, 2, 1, 1));
  assert.deepEqual(setup.received, ['申请前半段申请后半段']);
  assert.deepEqual(setup.revisions, [1]);
  assert.deepEqual(setup.errors, []);
  assert.equal(setup.states.at(-1)?.revision, 2);
  assert.equal(setup.states.at(-1)?.controlRevision, 1);
  setup.peer.close();
});

test('WebRTC 控制回执严格有界解码，业务拒绝回执不作为连接故障', () => {
  const setup = fixture(false, true);
  setup.connection.emitChannel(setup.channel);
  setup.channel.emitMessage(JSON.stringify({ version: 1, epoch: 1, type: 'control_result',
    request_id: clientId, ok: false, error: '当前控制者拒绝申请' }));
  assert.deepEqual(setup.results, [{ requestId: clientId, ok: false, error: '当前控制者拒绝申请' }]);
  assert.deepEqual(setup.errors, []);
  setup.peer.close();
  for (const overrides of [{ request_id: '无效' }, { ok: 'true' }, { ok: true, error: '成功不能带错误' },
    { error: '\0' }, { error: 'a'.repeat(1025) }, { extra: true }, { epoch: 2 }]) {
    const invalid = fixture(false, true);
    invalid.connection.emitChannel(invalid.channel);
    invalid.channel.emitMessage(JSON.stringify({ version: 1, epoch: 1, type: 'control_result',
      request_id: clientId, ok: false, ...overrides }));
    assert.deepEqual(invalid.results, []);
    assert.deepEqual(invalid.errors, ['mirroring_webrtc_ownership_invalid']);
    invalid.peer.close();
  }
});
