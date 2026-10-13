import assert from 'node:assert/strict';
import { rawPerfBytes, expectedStacks, packageName, targetPid, processStartTicks } from './protocol.mjs';
import { deviceId } from './probe-route.mjs';
import { download } from './downloads.mjs';
import { storedEntries } from './zip.mjs';

export async function consume(host, directory, report, scenario, published, frontend) {
  const { result, artifacts } = published;
  assert.deepEqual(Object.keys(published).sort(), ['artifacts', 'result'], 'PROFILE-PUBLISHED-ENVELOPE');
  assert.deepEqual(result, { format_version: 1, device_id: deviceId, package: packageName, pid: targetPid, process_start_ticks: processStartTicks,
    clock: 'boottime', frame_kind: 'scrcpy_sampled_frame', display_frame_complete: false, ...scenario.expected,
    stack_sample_count: scenario.expected.stack_status === 'captured' ? 4 : 0, reported_sample_count: scenario.expected.stack_status === 'captured' ? '4' : '0',
    lost_count: scenario.expected.stack_status === 'captured' ? '2' : '0', index_filename: 'profile-index.json', archive_filename: 'profile.zip' }, 'PROFILE-EXACT-RESULT');
  assert.equal(artifacts.length, 2, 'PROFILE-PUBLISHED-TWO-ARTIFACTS');
  const indexArtifact = artifacts.find(value => value.filename === 'profile-index.json'), archiveArtifact = artifacts.find(value => value.filename === 'profile.zip');
  assert.ok(indexArtifact && archiveArtifact, 'PROFILE-PUBLISHED-FILENAMES');
  const indexBytes = await download(host, directory, report, indexArtifact, scenario.id);
  const archiveBytes = await download(host, directory, report, archiveArtifact, scenario.id);
  const files = storedEntries(archiveBytes); assert.deepEqual(files.get('profile-index.json'), indexBytes, 'PROFILE-ZIP-INDEX-EXACT-BYTES');
  const captured = scenario.expected.stack_status === 'captured';
  assert.deepEqual([...files.keys()].sort(), (captured ? ['perf.bin', 'profile-index.json', 'stacks.jsonl'] : ['profile-index.json', 'stacks.jsonl']).sort(), 'PROFILE-ZIP-EXACT-ENTRIES');
  if (captured) assert.deepEqual(files.get('perf.bin'), rawPerfBytes, 'PROFILE-RAW-TRACE-ORIGINAL-BYTES');
  const index = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(indexBytes));
  assert.equal(index.samples.length, 1); const sample = index.samples[0];
  assert.equal(sample.index, 0); assert.equal(sample.begin_ns, '10000000000'); assert.equal(sample.end_ns, '10110000000');
  assert.equal(sample.target_ns, '10055000000'); assert.equal(sample.frame, null);
  assert.equal(sample.metrics.pid, targetPid); assert.equal(sample.metrics.process_start_ticks, 900);
  assert.equal(sample.metrics.pss_kib, 2048); assert.equal(sample.metrics.rss_kib, 4096);
  assert.equal(sample.metrics.logical_cpus, 2); assert.ok(sample.metrics.frame_window == null);
  assert.deepEqual(sample.stack_sample_indices, captured ? [0, 1] : [], 'PROFILE-ONLY-DEVICE-TIME-ASSOCIATION');
  const stacks = files.get('stacks.jsonl').length ? files.get('stacks.jsonl').toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line)) : [];
  const golden = captured ? expectedStacks() : []; assert.equal(stacks.length, golden.length);
  for (const [ordinal, stack] of stacks.entries()) {
    const expected = golden[ordinal];
    assert.deepEqual(stack, { time_ns: expected.time_ns, thread_id: expected.tid, process_id: expected.pid, thread_name: expected.thread,
      event_count: expected.event_count, event_type: expected.event_type, callchain: [
        { file: '/data/app/org.smoke.profile.game/lib/arm64/libgame.so', symbol: expected.leaf_symbol, address: '0x' + Number(expected.leaf_address).toString(16), execution_type: 'native' },
        { file: '/system/lib64/libc.so', symbol: expected.caller_symbol, address: '0x' + Number(expected.caller_address).toString(16), execution_type: 'native' }], unwinding: null }, 'PROFILE-LATE-SYMBOL-EXACT-STACK');
  }
  const validated = frontend.decodeProfileResult(published, archiveArtifact.id, deviceId, packageName);
  const opened = await frontend.downloadAndOpenProfileArchive({ download: async id => {
    assert.equal(id, archiveArtifact.id, 'PROFILE-FRONTEND-PUBLISHED-ZIP-ID');
    return { data: new Blob([Uint8Array.from(archiveBytes)], { type: 'application/zip' }), logId: report.downloads.at(-1).log_id };
  } }, validated, AbortSignal.timeout(10000));
  assert.deepEqual(opened.data.index, index, 'PROFILE-ACTUAL-FRONTEND-INDEX');
  assert.deepEqual(opened.data.stacks, stacks, 'PROFILE-ACTUAL-FRONTEND-STACKS');
  assert.equal(opened.data.frames.length, 0); assert.equal(opened.data.perf !== null, captured);
  if (captured) assert.deepEqual(Buffer.from(await opened.data.perf.arrayBuffer()), rawPerfBytes);
  assert.deepEqual(opened.data.timeline.samples[0].stacks.map(value => value.index), captured ? [0, 1] : []);
  assert.deepEqual(opened.data.timeline.unassociated.map(value => value.index), captured ? [2, 3] : []);
  report.profiles ??= []; report.profiles.push({ case_id: scenario.id, result, index, stacks, archive_members: [...files.keys()],
    frontend_consumed: true, unassociated_indices: opened.data.timeline.unassociated.map(value => value.index) });
}
