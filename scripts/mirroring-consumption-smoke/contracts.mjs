import assert from 'node:assert/strict';

export const statusOperation = 'plugin.mirroring.runtime.status';
export const recordOperation = 'plugin.mirroring.record';
export const version = 'scrcpy 3.2\n';
export const video = Buffer.from(
  '000000186674797069736f6d0000020069736f6d69736f320000000c6d64617444544121',
  'hex',
);
export const invalidVideo = Buffer.alloc(12);
export const basic = { device_id: 'device-1', duration_ms: 1000 };
export const selected = { device_id: 'device:2', duration_ms: 1001, max_size: 640, max_fps: 15 };
export const mcpInput = { device_id: 'device.3', duration_ms: 2501, max_size: 720, max_fps: 24 };

export function sourceContract(manifest) {
  assert.equal(manifest.id, 'mirroring');
  assert.equal(manifest.protocol_version, 4);
  assert.deepEqual(
    manifest.operations.map((value) => value.name),
    ['runtime.status', 'record'],
  );
  assert.deepEqual(manifest.artifacts, { input_fields: [], outputs: true });
  for (const operation of manifest.operations)
    assert.deepEqual(operation.execution, { api_version: 1, total_timeout_ms: 150000 });
  assert.deepEqual(manifest.operations[1].input_schema.required, ['device_id', 'duration_ms']);
  assert.deepEqual(Object.keys(manifest.operations[1].input_schema.properties).sort(), [
    'device_id',
    'duration_ms',
    'max_fps',
    'max_size',
  ]);
}

export function recording(input) {
  return {
    device_id: input.device_id,
    duration_ms: Math.ceil(input.duration_ms / 1000) * 1000,
    codec: 'h264',
    filename: 'screen.mp4',
    size: video.length,
    live_stream: false,
  };
}

export function recordArgv(input, path) {
  return [
    '--serial',
    input.device_id,
    '--no-playback',
    '--no-control',
    '--no-audio',
    '--video-codec=h264',
    '--record=' + path,
    '--record-format=mp4',
    '--max-size=' + (input.max_size ?? 1280),
    '--max-fps=' + (input.max_fps ?? 30),
    '--time-limit=' + Math.ceil(input.duration_ms / 1000),
  ];
}
