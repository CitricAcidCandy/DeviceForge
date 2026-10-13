import assert from 'node:assert/strict';
import test from 'node:test';
import { createAndroidProfile, decodeProbe, decodeProfileResult, decodeProfileIndex, decodeStackJsonLines, buildProfileTimeline, downloadProfileIndex, downloadProfileArchive, PROFILE_LIMITS, JobWaitFailure } from '../src/features/android-profile/index.ts';
import type { ProfileHost, ProfileResult, StackSample } from '../src/features/android-profile/index.ts';
import { ApiError } from '../src/shared/api/index.ts';
import type { ArtifactDto } from '../src/shared/api/index.ts';
import { requireJson } from '../src/shared/jobs/index.ts';
import type { Job } from '../src/plugin-sdk/index.ts';
import { deferred, signal } from './fixtures.ts';

const device = 'emulator-5554'; const packageId = 'com.example.game';
const reference = { providerId: 'android-device', generation: 'generation-1', localId: device };
const operation = 'android-device.profile.record';
function result(): ProfileResult {
  return { format_version: 1, device_id: device, package: packageId, pid: 42, process_start_ticks: '900', clock: 'boottime',
    frame_kind: 'sampled_screenshot', display_frame_complete: false, root_access: 'su', stack_status: 'captured', stack_reason: null, sample_count: 1, stack_sample_count: 3, lost_count: '0', frame_count: 1,
    index_filename: 'profile-index.json', archive_filename: 'profile.zip' };
}
function artifact(filename: string, size = 1, sha256 = 'a'.repeat(64)): ArtifactDto {
  return { id: filename, filename, size, sha256, media_type: filename.endsWith('.json') ? 'application/json' : 'application/zip', created_at: 1 };
}
function envelope() { return { result: result(), artifacts: [artifact('profile-index.json'), artifact('profile.zip')] }; }
function indexValue() {
  const { sample_count, frame_count, index_filename, archive_filename, ...identity } = result();
  assert.ok(sample_count && frame_count && index_filename && archive_filename);
  return { ...identity, symbolication: 'reported_symbols_only', samples: [{ index: 0, begin_ns: '90071992547409930', end_ns: '90071992547409939',
    metrics: { captured_at: 1000, pid: 42, process_start_ticks: 900, process_ticks: 100, system_ticks: 1000, logical_cpus: 8, pss_kib: 200, rss_kib: null },
    frame: { index: 0, filename: 'frames/000000.png', begin_ns: '90071992547409933', end_ns: '90071992547409935' }, stack_sample_indices: [0, 1] }] };
}
function stack(time: string): StackSample {
  return { time_ns: time, thread_id: 43, process_id: 42, thread_name: null, event_count: '1', event_type: 'cpu-clock',
    callchain: [{ file: 'libgame.so', symbol: null, address: '0x1234', execution_type: 'native' }], unwinding: null };
}
function protocolLog(error: unknown) { return error instanceof ApiError && error.kind === 'protocol' && error.logId === 'profile-log'; }

test('资格及录制封套严格保留真实资格、身份、产物名单和日志', () => {
  const probe = { format_version: 1, device_id: device, package: packageId, root_access: 'none', simpleperf_available: true, clock: 'boottime', supported: false, reason: 'root_unavailable' };
  assert.equal(decodeProbe({ result: probe, artifacts: [] }, 'profile-log', device, packageId).supported, false);
  assert.equal(decodeProbe({ result: { ...probe, root_access: 'su', simpleperf_available: false, reason: 'simpleperf_unavailable' }, artifacts: [] }, 'profile-log', device, packageId).supported, false);
  assert.throws(() => decodeProbe({ result: { ...probe, supported: true }, artifacts: [] }, 'profile-log', device, packageId), protocolLog);
  assert.deepEqual(decodeProfileResult(envelope(), 'profile-log', device, packageId).result, result());
  assert.throws(() => decodeProfileResult({ ...envelope(), result: { ...result(), display_frame_complete: true } }, 'profile-log', device, packageId), protocolLog);
  assert.throws(() => decodeProfileResult({ ...envelope(), result: { ...result(), process_start_ticks: '0900' } }, 'profile-log', device, packageId), protocolLog);
  assert.throws(() => decodeProfileResult({ ...envelope(), artifacts: [artifact('profile-index.json'), artifact('profile.zip', PROFILE_LIMITS.archiveBytes + 1)] }, 'profile-log', device, packageId), protocolLog);
  assert.throws(() => decodeProfileResult({ ...envelope(), result: { ...result(), package: 'com.other.game' } }, 'profile-log', device, packageId), protocolLog);
});

test('索引只接收同一进程和原始样本，不补派生FPS或截断超限索引', () => {
  const value = indexValue(); const accepted = decodeProfileIndex(value, result(), 'profile-log');
  assert.equal(Object.hasOwn(accepted.samples[0]?.metrics ?? {}, 'fps'), false);
  assert.equal(Object.hasOwn(accepted.samples[0]?.metrics ?? {}, 'sequence'), false);
  const row = value.samples[0]; assert.ok(row);
  assert.throws(() => decodeProfileIndex({ ...value, samples: [{ ...row, metrics: { ...row.metrics, pid: 99 } }] }, result(), 'profile-log'), protocolLog);
  assert.throws(() => decodeProfileIndex({ ...value, samples: [{ ...row, metrics: { ...row.metrics, sequence: 1 } }] }, result(), 'profile-log'), protocolLog);
  assert.throws(() => decodeProfileIndex({ ...value, samples: [{ ...row, frame: { ...row.frame, filename: '../outside.png' } }] }, result(), 'profile-log'), protocolLog);
  assert.throws(() => decodeProfileIndex({ ...value, samples: [{ ...row, stack_sample_indices: [0, 0] }] }, result(), 'profile-log'), protocolLog);
  assert.throws(() => decodeProfileIndex({ ...value, samples: [{ ...row, stack_sample_indices: Array.from({ length: 4097 }, () => 0) }] }, result(), 'profile-log'), protocolLog);
});

test('boottime超安全整数仍精确关联采样与截图区间，区间外保留未关联', () => {
  const index = decodeProfileIndex(indexValue(), result(), 'profile-log');
  const stacks = [stack('90071992547409931'), stack('90071992547409934'), stack('90071992547409940')];
  const timeline = buildProfileTimeline(index, stacks, 'profile-log');
  assert.deepEqual(timeline.samples[0]?.stacks.map((entry) => entry.index), [0, 1]);
  assert.deepEqual(timeline.samples[0]?.frameStacks.map((entry) => entry.index), [1]);
  assert.deepEqual(timeline.unassociated.map((entry) => entry.index), [2]);
  assert.deepEqual(timeline.withoutFrame.map((entry) => entry.index), [0, 2]);
  assert.equal(timeline.symbolication, 'reported_symbols_only'); assert.equal(timeline.displayFrameComplete, false);
  assert.equal(timeline.samples[0]?.stacks[0]?.sample.callchain[0]?.symbol, null);
  assert.throws(() => buildProfileTimeline(index, [stacks[0] ?? stack('0'), stack('90071992547409940'), stacks[2] ?? stack('0')], 'profile-log'), protocolLog);
  assert.throws(() => buildProfileTimeline(index, [{ ...stack('90071992547409931'), process_id: 99 }, stacks[1] ?? stack('0'), stacks[2] ?? stack('0')], 'profile-log'), protocolLog);
});

test('JSONL保留零基行号与叶到根链，拒绝降序、非法UTF8和过深链', () => {
  const first = stack('90071992547409931'); const second = stack('90071992547409934');
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value) + '\n');
  const accepted = decodeStackJsonLines(new TextEncoder().encode(JSON.stringify(first) + '\n' + JSON.stringify(second) + '\n'), 'profile-log');
  assert.equal(accepted.length, 2); assert.equal(accepted[1]?.time_ns, second.time_ns);
  assert.deepEqual(accepted[0]?.callchain, first.callchain);
  assert.throws(() => decodeStackJsonLines(new TextEncoder().encode(JSON.stringify(second) + '\n' + JSON.stringify(first)), 'profile-log'), protocolLog);
  assert.throws(() => decodeStackJsonLines(new Uint8Array([255, 10]), 'profile-log'), protocolLog);
  assert.throws(() => decodeStackJsonLines(encode({ ...first, callchain: Array.from({ length: 257 }, () => first.callchain[0]) }), 'profile-log'), protocolLog);
  assert.throws(() => decodeStackJsonLines(new TextEncoder().encode(' '.repeat(PROFILE_LIMITS.lineBytes + 1)), 'profile-log'), protocolLog);
  const cancelled = new AbortController(); cancelled.abort();
  assert.throws(() => decodeStackJsonLines(encode(first), 'profile-log', cancelled.signal), { name: 'AbortError' });
});

async function sha256(blob: Blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
test('索引及ZIP下载按原字节核摘要，解析和完整性失败保留下载日志', async () => {
  const json = new Blob([JSON.stringify(indexValue())], { type: 'application/json' }); const zip = new Blob(['archive-bytes']);
  const published = { result: result(), artifacts: [artifact('profile-index.json', json.size, await sha256(json)), artifact('profile.zip', zip.size, await sha256(zip))] };
  const reader = { download: async (id: string) => ({ data: id === 'profile-index.json' ? json : zip, logId: 'download-log' }) };
  const index = await downloadProfileIndex(reader, published, signal());
  assert.equal(index.logId, 'download-log'); assert.equal(index.data.pid, 42);
  assert.equal(await (await downloadProfileArchive(reader, published, signal())).data.text(), 'archive-bytes');
  await assert.rejects(downloadProfileIndex({ download: async () => ({ data: new Blob(['x'.repeat(json.size)]), logId: 'download-corrupt' }) }, published, signal()),
    (error: unknown) => error instanceof ApiError && error.code === 'artifact_digest_mismatch' && error.logId === 'download-corrupt');
  const invalidJson = new Blob(['{']); const invalidPublished = { ...published, artifacts: [artifact('profile-index.json', invalidJson.size, await sha256(invalidJson)), published.artifacts[1] ?? artifact('profile.zip')] };
  await assert.rejects(downloadProfileIndex({ download: async () => ({ data: invalidJson, logId: 'profile-log' }) }, invalidPublished, signal()), protocolLog);
});

function task(value: unknown, status: Job['status'] = 'succeeded'): Job {
  return { id: 'profile-job', operation, status, result: requireJson(value), error: null };
}
function makeHost(invoke: NonNullable<ProfileHost['devices']>['invoke'], getJob: ProfileHost['getJob']): ProfileHost {
  return { signal: signal(), onDispose: () => () => undefined, getJob, cancelJob: async () => ({ data: task(null, 'cancelled'), logId: 'cancel-log' }),
    devices: { invoke, refreshProviders: async () => ({ data: [], logId: null }), refreshDirectories: async () => ({ data: [], logId: null }),
      refreshProvider: async () => { throw new Error('测试不得刷新目录'); }, select: () => undefined,
      snapshot: () => ({ providers: [], directories: [], selection: null, selected: null }), subscribe: () => () => undefined } };
}
test('公开设备调用保留完整代次与能力，默认采样画面并传递提交日志', async () => {
  const calls: unknown[] = [];
  const host = makeHost(async (action, requestSignal) => {
    assert.equal(requestSignal.aborted, false); calls.push(action); return { data: task(envelope()), logId: 'submit-log' };
  }, async () => { throw new Error('成功终态不查询'); });
  const factory = createAndroidProfile(host, reference, { pollIntervalMs: 0 });
  try {
    const response = await factory.record({ package: packageId, duration_ms: 1000, interval_ms: 1000 }, signal());
    assert.equal(response.submitLogId, 'submit-log'); assert.equal(response.logId, 'submit-log');
    assert.deepEqual(calls, [{ providerId: 'android-device', generation: 'generation-1', deviceId: device,
      capability: 'profile.record', version: 1, input: { package: packageId, duration_ms: 1000, interval_ms: 1000, capture_frames: true } }]);
    assert.throws(() => factory.record({ package: packageId, duration_ms: 1000, interval_ms: 1001 }, signal()), (error: unknown) => error instanceof ApiError && error.code === 'invalid_android_profile_input');
    assert.equal(calls.length, 1);
  } finally { factory.dispose(); }
});

test('取消等待不重提或自动取消服务器任务，恢复原Job并保留各阶段日志', async () => {
  let submits = 0; let queries = 0; const requested = deferred<void>(); const pending = deferred<{ data: Job; logId: string | null }>();
  const host = makeHost(async () => { submits += 1; return { data: task(null, 'running'), logId: 'submit-log' }; }, async () => {
    queries += 1;
    if (queries === 1) { requested.resolve(); return pending.promise; }
    return { data: task(envelope()), logId: 'resume-log' };
  });
  const factory = createAndroidProfile(host, reference, { pollIntervalMs: 0 }); const controller = new AbortController();
  try {
    const waiting = factory.record({ package: packageId, duration_ms: 1000, interval_ms: 1000 }, controller.signal);
    const rejected = assert.rejects(waiting, (error: unknown) => error instanceof JobWaitFailure && error.job.id === 'profile-job' && error.submitLogId === 'submit-log');
    await requested.promise; controller.abort(); await rejected;
    const resumed = await factory.resumeRecording({ id: 'profile-job', operation, submitLogId: 'submit-log' }, packageId, signal());
    assert.equal(submits, 1); assert.equal(queries, 2); assert.equal(resumed.logId, 'resume-log'); assert.equal(resumed.submitLogId, 'submit-log');
    assert.equal((await factory.cancel({ id: 'profile-job', operation, submitLogId: 'submit-log' }, signal())).data.status, 'cancelled');
  } finally { pending.resolve({ data: task(envelope()), logId: 'late-log' }); factory.dispose(); }
});

test('截图有独立时间区间，指标区间外的堆栈仍可与对应截图关联', () => {
  const value = indexValue(); const row = value.samples[0]; assert.ok(row);
  const shifted = { ...value, samples: [{ ...row, frame: { ...row.frame, begin_ns: '90071992547409940', end_ns: '90071992547409942' } }] };
  const index = decodeProfileIndex(shifted, result(), 'profile-log');
  const timeline = buildProfileTimeline(index, [stack('90071992547409931'), stack('90071992547409934'), stack('90071992547409940')], 'profile-log');
  assert.deepEqual(timeline.samples[0]?.stacks.map((entry) => entry.index), [0, 1]);
  assert.deepEqual(timeline.samples[0]?.frameStacks.map((entry) => entry.index), [2]);
  assert.deepEqual(timeline.unassociated.map((entry) => entry.index), [2]);
  assert.deepEqual(timeline.withoutFrame.map((entry) => entry.index), [0, 1]);
});

test('无Root或缺simpleperf仍成功返回指标和截图，堆栈保留不可用原因', async () => {
  const unavailable: ProfileResult = { ...result(), root_access: 'none', stack_status: 'unavailable', stack_reason: 'root_unavailable', stack_sample_count: 0, lost_count: '0' };
  const value = indexValue(); const row = value.samples[0]; assert.ok(row);
  const unavailableIndex = { ...value, root_access: unavailable.root_access, stack_status: unavailable.stack_status, stack_reason: unavailable.stack_reason,
    stack_sample_count: 0, lost_count: '0', samples: [{ ...row, stack_sample_indices: [] }] };
  const host = makeHost(async () => ({ data: task({ ...envelope(), result: unavailable }), logId: 'no-root-log' }), async () => { throw new Error('不查询成功终态'); });
  const factory = createAndroidProfile(host, reference, { pollIntervalMs: 0 });
  try {
    const recorded = await factory.record({ package: packageId, duration_ms: 1000, interval_ms: 1000 }, signal());
    assert.equal(recorded.data.result.stack_status, 'unavailable'); assert.equal(recorded.data.result.frame_count, 1);
    const accepted = decodeProfileIndex(unavailableIndex, recorded.data.result, 'profile-log');
    assert.equal(accepted.samples[0]?.metrics.pss_kib, 200); assert.equal(accepted.samples[0]?.frame?.filename, 'frames/000000.png');
    const timeline = buildProfileTimeline(accepted, [], 'profile-log');
    assert.equal(timeline.stackStatus, 'unavailable'); assert.equal(timeline.rootAccess, 'none'); assert.equal(timeline.stackReason, 'root_unavailable');
    assert.equal(timeline.samples.length, 1); assert.deepEqual(timeline.samples[0]?.stacks, []);
    assert.throws(() => decodeProfileResult({ ...envelope(), result: { ...unavailable, stack_sample_count: 1 } }, 'profile-log', device, packageId), protocolLog);
    assert.throws(() => decodeProfileResult({ ...envelope(), result: { ...unavailable, stack_reason: '' } }, 'profile-log', device, packageId), protocolLog);
    assert.throws(() => decodeProfileIndex({ ...unavailableIndex, samples: [{ ...row, stack_sample_indices: [0] }] }, unavailable, 'profile-log'), protocolLog);
  } finally { factory.dispose(); }
});
