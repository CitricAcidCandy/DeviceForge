import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createMediaDisplay } from '../src/app/product/media-display.ts';
import { FakeMediaStream, FakeMediaTrack } from './webrtc-fixtures.ts';

test('同一 video 重绑定或相同流更新音频状态不重新挂载媒体', async () => {
  const display = createMediaDisplay();
  let assignments = 0;
  let source: MediaStream | null = null;
  const video = new JSDOM('<video></video>').window.document.querySelector('video');
  assert.ok(video);
  Object.defineProperty(video, 'play', { value: async () => {} });
  Object.defineProperty(video, 'pause', { value: () => {} });
  Object.defineProperty(video, 'srcObject', {
    get: () => source,
    set(value: MediaStream | null) { source = value; ++assignments; },
  });
  const audio = new FakeMediaTrack('audio');
  const stream = new FakeMediaStream();
  stream.addTrack(audio);
  display.bindVideo(video);
  await display.playWebRtc(stream, false);
  assert.equal(video.muted, true);
  assert.equal(audio.enabled, false);
  assert.equal(assignments, 2);
  display.bindVideo(video);
  await display.playWebRtc(stream, true);
  assert.equal(assignments, 2);
  assert.equal(video.muted, false);
  assert.equal(audio.enabled, true);
  await display.dispose();
});
