import assert from 'node:assert/strict';
import test from 'node:test';
import { createMirroring } from '../src/features/mirroring/index.ts';
import { ApiError } from '../src/services/api/index.ts';
import type { ArtifactDto } from '../src/services/api/index.ts';
import type { ArtifactReader, JobGateway, JsonData } from '../src/shared/jobs/index.ts';
import { signal } from './fixtures.ts';

const input = { device_id: 'emulator-5554', duration_ms: 1100 };
const video = new Blob([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109])], {
  type: 'video/mp4',
});
function metadata(size: number, sha256: string): ArtifactDto {
  return {
    id: 'video-id',
    filename: 'screen.mp4',
    size,
    sha256,
    media_type: 'video/mp4',
    created_at: 1,
  };
}
function gateway(respond: (operation: string, value: JsonData) => JsonData): JobGateway {
  return {
    submit: async (operation, value) => ({
      data: {
        id: 'video-job',
        operation,
        status: 'succeeded',
        error: null,
        result: respond(operation, value),
      },
      logId: 'video-log',
    }),
    getJob: async () => {
      throw new Error('终态不应查询');
    },
    cancelJob: async () => {
      throw new Error('未授权取消');
    },
  };
}
const reader: ArtifactReader = { download: async () => ({ data: video, logId: 'download-log' }) };
test('投屏状态与录像消费明确保留非直播、整秒时长与产物身份', async () => {
  const calls: { operation: string; input: JsonData }[] = [];
  const mirror = createMirroring(
    gateway((operation, value) => {
      calls.push({ operation, input: value });
      if (operation.endsWith('.status'))
        return {
          result: { available: true, version: 'scrcpy 3', live_stream: false, recording: true },
          artifacts: [],
        };
      return {
        result: {
          device_id: input.device_id,
          duration_ms: 2000,
          codec: 'h264',
          filename: 'screen.mp4',
          size: video.size,
          live_stream: false,
        },
        artifacts: [
          {
            id: 'video-id',
            filename: 'screen.mp4',
            size: video.size,
            sha256: 'a'.repeat(64),
            media_type: 'video/mp4',
            created_at: 1,
          },
        ],
      };
    }),
    reader,
  );
  assert.equal((await mirror.runtimeStatus(signal())).data.live_stream, false);
  const recorded = await mirror.record(input, signal());
  assert.equal(recorded.data.result.duration_ms, 2000);
  assert.equal(recorded.data.result.live_stream, false);
  assert.deepEqual(calls[1]?.input, input);
  assert.equal(calls[1]?.operation, 'plugin.mirroring.record');
  mirror.dispose();
});
test('录像拒绝自由字段、不合法编码、错文件大小与直播结果', async () => {
  const mirror = createMirroring(
    gateway(() => ({
      result: {
        device_id: input.device_id,
        duration_ms: 2000,
        codec: 'h264',
        filename: 'screen.mp4',
        size: video.size + 1,
        live_stream: false,
      },
      artifacts: [
        {
          id: 'video-id',
          filename: 'screen.mp4',
          size: video.size,
          sha256: 'a'.repeat(64),
          media_type: 'video/mp4',
          created_at: 1,
        },
      ],
    })),
    reader,
  );
  assert.throws(() => mirror.record({ ...input, max_fps: 61 }, signal()), ApiError);
  const extra = { ...input, path: 'C:/record.mp4' };
  assert.throws(() => mirror.record(extra, signal()), ApiError);
  await assert.rejects(
    mirror.record(input, signal()),
    (error: unknown) => error instanceof ApiError && error.logId === 'video-log',
  );
  mirror.dispose();
  const live = createMirroring(
    gateway(() => ({
      result: { available: true, version: 'scrcpy 3', live_stream: true, recording: true },
      artifacts: [],
    })),
    reader,
  );
  await assert.rejects(live.runtimeStatus(signal()), ApiError);
  live.dispose();
});
test('视频原字节下载核验SHA256与MP4头，不能替代实际播放验收', async () => {
  const hash = await crypto.subtle.digest('SHA-256', await video.arrayBuffer());
  const digest = Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  const result: {
    device_id: string;
    duration_ms: number;
    codec: 'h264';
    filename: 'screen.mp4';
    size: number;
    live_stream: false;
  } = {
    device_id: input.device_id,
    duration_ms: 2000,
    codec: 'h264',
    filename: 'screen.mp4',
    size: video.size,
    live_stream: false,
  };
  const mirror = createMirroring(
    gateway(() => ({})),
    reader,
  );
  const downloaded = await mirror.downloadRecording(
    { result, artifacts: [metadata(video.size, digest)] },
    signal(),
  );
  assert.equal(downloaded.data, video);
  assert.equal(downloaded.logId, 'download-log');
  mirror.dispose();
  const fake = new Blob(['not-mp4-data']);
  const fakeHash = await crypto.subtle.digest('SHA-256', await fake.arrayBuffer());
  const fakeDigest = Array.from(new Uint8Array(fakeHash), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  const invalid = createMirroring(
    gateway(() => ({})),
    { download: async () => ({ data: fake, logId: 'fake-log' }) },
  );
  await assert.rejects(
    invalid.downloadRecording(
      { result: { ...result, size: fake.size }, artifacts: [metadata(fake.size, fakeDigest)] },
      signal(),
    ),
    (error: unknown) =>
      error instanceof ApiError &&
      error.code === 'invalid_mirroring_video' &&
      error.logId === 'fake-log',
  );
  invalid.dispose();
});
