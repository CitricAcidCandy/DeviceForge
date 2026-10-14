import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { poll } from '../device-provider/client.mjs';
import { assertClean, connected, controlObserved, readIfExists } from './fixtures.mjs';
import {
  audioPacket,
  controlGolden,
  parseDfml,
  videoConfig,
  videoDelta,
  videoKey,
} from './golden.mjs';

export function recordOpened(report, info, logId) {
  assert.ok(!report.opened.some((entry) => entry.id === info.id));
  report.opened.push({
    id: info.id,
    plugin_id: info.plugin_id,
    generation: info.generation,
    operation: info.operation,
    log_id: logId,
  });
}

export async function rawFrames(host, id) {
  const page = await host.client.json(`/api/v2/sessions/${id}/output?after=0&limit=100`);
  const bytes = Buffer.concat(
    page.chunks
      .filter((chunk) => chunk.stream === 'stdout')
      .map((chunk) => Buffer.from(chunk.bytes)),
  );
  return { page, bytes, ...parseDfml(bytes) };
}

export function assertGoldenFrames(frames, epoch = 1, { audio = true } = {}) {
  const current = frames.filter((frame) => frame.epoch === epoch);
  const videos = current.filter((frame) => frame.kind === 2);
  assert.deepEqual(
    videos.map((frame) => frame.payload),
    [videoConfig, videoKey, videoDelta],
  );
  assert.deepEqual(
    videos.map((frame) => frame.flags),
    [2, 1, 0],
  );
  assert.deepEqual(
    videos.map((frame) => frame.pts),
    ['0', '33333', '66666'],
  );
  const video = current.find((frame) => frame.kind === 1);
  assert.ok(video);
  assert.equal(video.json.codec, 'h264');
  assert.equal(video.json.width, 1280);
  assert.equal(video.json.height, 720);
  const audios = current.filter((frame) => frame.kind === 4);
  assert.deepEqual(
    audios.map((frame) => frame.payload),
    audio ? [audioPacket] : [],
  );
  if (audio) {
    assert.equal(audios[0].pts, '20000');
    const configuration = current.find((frame) => frame.kind === 3);
    assert.ok(configuration);
    assert.equal(configuration.json.codec, 'pcm_s16le');
    assert.equal(configuration.json.sample_rate, 48000);
    assert.equal(configuration.json.channels, 2);
  }
}

export async function waitMedia(host, id, epoch = 1, { audio = true } = {}) {
  return poll(
    async () => {
      const page = await rawFrames(host, id);
      if (
        page.page.session.status === 'finished' &&
        !page.frames.some((frame) => frame.epoch === epoch && frame.kind === 2)
      ) {
        const error = new Error(
          '目标连接在黄金媒体前终态：' +
            (page.page.session.completion?.outcome?.error ?? '无业务错误'),
        );
        error.session = page.page.session;
        throw error;
      }
      return page;
    },
    (page) =>
      page.frames.filter((frame) => frame.epoch === epoch && frame.kind === 2).length >= 3 &&
      (!audio || page.frames.some((frame) => frame.epoch === epoch && frame.kind === 4)),
    'DFML视频音频原包',
  );
}

export async function readFrontend(frontend, packets, epoch = 1) {
  await poll(
    async () => {
      const page = await frontend.readOutput({ limit: 100 }, AbortSignal.timeout(10000));
      if (page.data.session.status === 'finished') {
        const error = new Error(
          '直播在黄金媒体前已终态：' +
            (page.data.session.completion?.outcome?.error ??
              page.data.session.completion?.failure?.message ??
              '无业务错误'),
        );
        error.session = page.data.session;
        throw error;
      }
      return frontend.snapshot();
    },
    (snapshot) =>
      snapshot.epoch === epoch &&
      snapshot.status?.state === 'streaming' &&
      packets.filter((packet) => packet.epoch === epoch && packet.kind === 'video').length >= 3 &&
      packets.some((packet) => packet.epoch === epoch && packet.kind === 'audio'),
    '实际前端DFML基础消费',
  );
  const videos = packets.filter((packet) => packet.epoch === epoch && packet.kind === 'video');
  assert.deepEqual(
    videos.map((packet) => Buffer.from(packet.bytes)),
    [videoConfig, videoKey, videoDelta],
  );
  assert.deepEqual(
    videos.map((packet) => packet.keyFrame),
    [false, true, false],
  );
  assert.deepEqual(
    packets
      .filter((packet) => packet.epoch === epoch && packet.kind === 'audio')
      .map((packet) => Buffer.from(packet.bytes)),
    [audioPacket],
  );
}

export async function sendFrontendControls(frontend, fixture, device) {
  const signal = () => AbortSignal.timeout(10000);
  for (const input of [
    { type: 'key', action: 'down', keycode: 3 },
    { type: 'key', action: 'up', keycode: 3 },
    { type: 'text', text: '你好🌍' },
    {
      type: 'touch',
      action: 'down',
      pointer_id: 1,
      x: 17,
      y: 23,
      width: 1280,
      height: 720,
      pressure: 1,
    },
  ]) {
    const receipt = await frontend.sendControl(input, signal());
    assert.equal(receipt.data.accepted, true);
  }
  const epoch = await connected(fixture, device);
  await controlObserved(epoch, controlGolden);
}

export async function finished(host, fixture, info, device, report, label, observer) {
  const result = await poll(
    () => host.client.json(`/api/v2/sessions/${info.id}`),
    (value) => value.status === 'finished',
    label,
  );
  assert.equal(result.completion.cleanup, 'complete');
  assert.equal(result.completion.process_exited, true);
  assert.deepEqual(await host.client.tool('deviceforge.get_session', { id: info.id }), result);
  await assertClean(fixture, device);
  const serverExit = await observer.verifyServerExit(device),
    sockets = [];
  // 生产可直接终止本地ADB；临终文件写入可能被截断，socket释放以持有原句柄的OS退出观测确认。
  for (const epoch of (await readdir(fixture.plan(device))).filter((name) =>
    /^epoch-\d+$/.test(name),
  )) {
    const directory = join(fixture.plan(device), epoch);
    if (await readIfExists(join(directory, 'fixture-disconnect'))) continue;
    sockets.push({
      epoch,
      peer_closed_marker: [...((await readIfExists(join(directory, 'peer-closed'))) ?? [])],
      sockets_closed_marker: [...((await readIfExists(join(directory, 'sockets-closed'))) ?? [])],
      proof: '原生server进程已退出，其socket句柄由操作系统释放',
    });
  }
  report.sessions.push({
    id: info.id,
    device,
    label,
    generation: info.generation,
    result,
    server_exit: serverExit,
    sockets,
  });
  return result;
}
