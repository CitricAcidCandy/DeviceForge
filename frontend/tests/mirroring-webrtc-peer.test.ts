import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebRtcPeer } from '../src/features/mirroring-streaming/services/webrtc.ts';
import { FakeControlChannel, FakeMediaStream, FakeMediaTrack, FakeWebRtcConnection } from './webrtc-fixtures.ts';

function fixture() {
  const connection = new FakeWebRtcConnection();
  const stream = new FakeMediaStream();
  const track = new FakeMediaTrack();
  const channel = new FakeControlChannel();
  const errors: string[] = [];
  let active = true;
  const peer = createWebRtcPeer({
    connectionFactory: () => connection,
    mediaStreamFactory: () => stream,
    audio: false,
    active: () => active,
    onStream: () => {},
    onControlReady: () => {},
    onFailure: (error) => { errors.push(error.code); },
  });
  return { peer, connection, stream, track, channel, errors, deactivate: () => { active = false; } };
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
