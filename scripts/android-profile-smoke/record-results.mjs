import assert from 'node:assert/strict';
import {
  rawPerfBytes,
  expectedStacks,
  packageName,
  targetPid,
  processStartTicks,
} from './protocol.mjs';
import { deviceId } from './probe-route.mjs';
import { download } from './downloads.mjs';
import { storedEntries } from './zip.mjs';

// 固定官方报告有4个双帧样本，仅第1号原样本缺少叶符号，均不带展开错误元数据。
const expectedQuality = Object.freeze({
  format_version: 1,
  capture: {
    mode: 'dwarf',
    event: 'cpu-clock',
    frequency_hz: 99,
    clock: 'boottime',
    report_filter: 'disabled',
    remove_gaps: 0,
  },
  counts: {
    reported_sample_count: '4',
    parsed_sample_count: '4',
    lost_count: '2',
    callchain_frame_count: 8,
    empty_callchain_sample_count: 0,
    single_frame_sample_count: 0,
    max_callchain_depth: 2,
    unwinding_error_sample_count: 0,
    unwinding_without_error_sample_count: 0,
    unwinding_metadata_missing_sample_count: 4,
    missing_symbol_frame_count: 1,
    missing_symbol_sample_count: 1,
  },
  depth_histogram: [{ depth: 2, count: 4 }],
  unwinding_error_histogram: [],
  architecture: {
    status: 'unavailable',
    device_arch: null,
    target_process_arch: null,
    reason: '官方报告protobuf未提供设备或目标进程架构，设备ABI列表不能代替目标ELF身份',
  },
  symbolication: {
    status: 'reported_symbols_only',
    build_id_status: 'unavailable',
    reason: '官方报告protobuf未提供Build ID，本轮仅保存报告已有符号',
  },
});

// 独立按归档原样本重建默认采样权重，不调用后端或前端聚合器。
function rebuildFolded(stacks) {
  const escaped = (value) =>
    value
      .replaceAll('%', '%25')
      .replaceAll(';', '%3B')
      .replaceAll('\r', '%0D')
      .replaceAll('\n', '%0A');
  const paths = new Map();
  let sampleCount = 0n;
  for (const stack of stacks) {
    if (!stack.callchain.length) continue;
    const frames = [...stack.callchain].reverse().map((frame) => {
      const symbol = frame.symbol?.length ? frame.symbol : null;
      return JSON.stringify([
        frame.execution_type,
        frame.file ?? null,
        symbol,
        symbol === null ? frame.address : null,
      ]);
    });
    const labels = [
      'event=' + JSON.stringify(stack.event_type ?? null),
      'pid=' + JSON.stringify(stack.process_id ?? null),
      'tid=' + stack.thread_id,
      ...frames,
    ];
    const path = labels.map(escaped).join(';');
    paths.set(path, (paths.get(path) ?? 0n) + 1n);
    sampleCount += 1n;
  }
  // Rust字符串排序按UTF-8字节；不用JavaScript UTF-16排序替代跨端合同。
  const lines = [...paths.entries()].sort(([left], [right]) =>
    Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')),
  );
  return {
    text: lines.map(([path, count]) => path + ' ' + count + '\n').join(''),
    lineCount: lines.length,
    sampleCount,
  };
}

export async function consume(host, directory, report, scenario, published, frontend) {
  const { result, artifacts } = published;
  assert.deepEqual(
    Object.keys(published).sort(),
    ['artifacts', 'result'],
    'PROFILE-PUBLISHED-ENVELOPE',
  );
  assert.deepEqual(
    result,
    {
      format_version: 1,
      device_id: deviceId,
      package: packageName,
      pid: targetPid,
      process_start_ticks: processStartTicks,
      clock: 'boottime',
      frame_kind: 'scrcpy_sampled_frame',
      display_frame_complete: false,
      ...scenario.expected,
      stack_sample_count: scenario.expected.stack_status === 'captured' ? 4 : 0,
      reported_sample_count: scenario.expected.stack_status === 'captured' ? '4' : '0',
      lost_count: scenario.expected.stack_status === 'captured' ? '2' : '0',
      index_filename: 'profile-index.json',
      archive_filename: 'profile.zip',
    },
    'PROFILE-EXACT-RESULT',
  );
  assert.equal(artifacts.length, 2, 'PROFILE-PUBLISHED-TWO-ARTIFACTS');
  const indexArtifact = artifacts.find((value) => value.filename === 'profile-index.json'),
    archiveArtifact = artifacts.find((value) => value.filename === 'profile.zip');
  assert.ok(indexArtifact && archiveArtifact, 'PROFILE-PUBLISHED-FILENAMES');
  const indexBytes = await download(host, directory, report, indexArtifact, scenario.id);
  const archiveBytes = await download(host, directory, report, archiveArtifact, scenario.id);
  const files = storedEntries(archiveBytes);
  assert.deepEqual(files.get('profile-index.json'), indexBytes, 'PROFILE-ZIP-INDEX-EXACT-BYTES');
  const captured = scenario.expected.stack_status === 'captured';
  assert.deepEqual(
    [...files.keys()].sort(),
    [
      ...(captured
        ? [
            'flamegraph.folded',
            'perf.bin',
            'profile-index.json',
            'stack-quality.json',
            'stacks.jsonl',
          ]
        : ['profile-index.json', 'stacks.jsonl']),
      ...(scenario.frame ? ['frames/000000.png'] : []),
    ].sort(),
    'PROFILE-ZIP-EXACT-ENTRIES',
  );
  if (scenario.frame)
    assert.deepEqual(
      files.get('frames/000000.png'),
      scenario.frame_bytes,
      'PROFILE-MEDIA-GOLDEN-SELECTED-FRAME-BYTES',
    );
  if (captured)
    assert.deepEqual(files.get('perf.bin'), rawPerfBytes, 'PROFILE-RAW-TRACE-ORIGINAL-BYTES');
  const index = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(indexBytes));
  assert.equal(index.samples.length, 1);
  const sample = index.samples[0];
  if (scenario.expected_derived)
    assert.deepEqual(
      sample.derived,
      scenario.expected_derived,
      'PROFILE-DERIVED-EXACT-FIRST-SAMPLE',
    );
  assert.equal(sample.index, 0);
  assert.equal(sample.begin_ns, '10000000000');
  assert.equal(sample.end_ns, '10110000000');
  assert.equal(sample.target_ns, '10055000000');
  assert.deepEqual(sample.frame, scenario.frame ?? null, 'PROFILE-MEDIA-EXACT-PTS-ASSOCIATION');
  assert.equal(sample.metrics.pid, targetPid);
  assert.equal(sample.metrics.process_start_ticks, 900);
  // 默认保留原固定数值；显式Android9摘要或部分缺测场景提供独立可空指标黄金。
  const expectedMetrics = scenario.expected_metrics ?? {
    pss_kib: 2048,
    rss_kib: 4096,
    logical_cpus: 2,
  };
  assert.deepEqual(
    Object.fromEntries(Object.keys(expectedMetrics).map((key) => [key, sample.metrics[key]])),
    expectedMetrics,
    'PROFILE-EXACT-METRIC-GOLDEN',
  );
  if (scenario.expected_metrics) {
    assert.ok(
      Number.isSafeInteger(sample.metrics.process_ticks) && sample.metrics.process_ticks > 0,
      'PROFILE-PARTIAL-KEEPS-PROCESS-TICKS',
    );
    if (expectedMetrics.logical_cpus !== null)
      assert.ok(
        Number.isSafeInteger(sample.metrics.system_ticks) && sample.metrics.system_ticks > 0,
        'PROFILE-PARTIAL-KEEPS-SYSTEM-TICKS',
      );
  }
  assert.ok(sample.metrics.frame_window == null);
  assert.deepEqual(
    sample.stack_sample_indices,
    captured ? [0, 1] : [],
    'PROFILE-ONLY-DEVICE-TIME-ASSOCIATION',
  );
  const stacks = files.get('stacks.jsonl').length
    ? files
        .get('stacks.jsonl')
        .toString('utf8')
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line))
    : [];
  const quality = captured
    ? JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(files.get('stack-quality.json')))
    : null;
  assert.deepEqual(
    quality,
    captured ? expectedQuality : null,
    'PROFILE-EXACT-STACK-QUALITY-GOLDEN',
  );
  const golden = captured ? expectedStacks() : [];
  assert.equal(stacks.length, golden.length);
  for (const [ordinal, stack] of stacks.entries()) {
    const expected = golden[ordinal];
    assert.deepEqual(
      stack,
      {
        time_ns: expected.time_ns,
        thread_id: expected.tid,
        process_id: expected.pid,
        thread_name: expected.thread,
        event_count: expected.event_count,
        event_type: expected.event_type,
        callchain: [
          {
            file: '/data/app/org.smoke.profile.game/lib/arm64/libgame.so',
            symbol: expected.leaf_symbol,
            address: '0x' + Number(expected.leaf_address).toString(16),
            execution_type: 'native',
          },
          {
            file: '/system/lib64/libc.so',
            symbol: expected.caller_symbol,
            address: '0x' + Number(expected.caller_address).toString(16),
            execution_type: 'native',
          },
        ],
        unwinding: null,
      },
      'PROFILE-LATE-SYMBOL-EXACT-STACK',
    );
  }
  let flamegraph = null;
  if (captured) {
    const expected = rebuildFolded(stacks),
      bytes = files.get('flamegraph.folded');
    assert.deepEqual(
      bytes,
      Buffer.from(expected.text, 'utf8'),
      'PROFILE-FOLDED-EXACT-REBUILT-UTF8-BYTES',
    );
    const text = new TextDecoder('utf8', { fatal: true }).decode(bytes);
    const rows = text.length ? text.slice(0, -1).split('\n') : [];
    let total = 0n;
    for (const row of rows) {
      const separator = row.lastIndexOf(' '),
        count = row.slice(separator + 1);
      assert.ok(
        separator > 0 && /^[1-9][0-9]*$/.test(count),
        'PROFILE-FOLDED-CANONICAL-SAMPLE-COUNT',
      );
      total += BigInt(count);
    }
    assert.equal(rows.length, expected.lineCount, 'PROFILE-FOLDED-AGGREGATED-LINE-COUNT');
    assert.equal(total, expected.sampleCount, 'PROFILE-FOLDED-TOTAL-NONEMPTY-SAMPLES');
    assert.equal(
      total,
      BigInt(stacks.filter((value) => value.callchain.length > 0).length),
      'PROFILE-FOLDED-TOTAL-ARCHIVED-SAMPLES',
    );
    flamegraph = {
      filename: 'flamegraph.folded',
      bytes: bytes.length,
      line_count: rows.length,
      sample_count: total.toString(),
    };
  }
  const validated = frontend.decodeProfileResult(
    published,
    archiveArtifact.id,
    deviceId,
    packageName,
  );
  const opened = await frontend.downloadAndOpenProfileArchive(
    {
      download: async (id) => {
        assert.equal(id, archiveArtifact.id, 'PROFILE-FRONTEND-PUBLISHED-ZIP-ID');
        return {
          data: new Blob([Uint8Array.from(archiveBytes)], { type: 'application/zip' }),
          logId: report.downloads.at(-1).log_id,
        };
      },
    },
    validated,
    AbortSignal.timeout(10000),
  );
  assert.deepEqual(opened.data.index, index, 'PROFILE-ACTUAL-FRONTEND-INDEX');
  assert.deepEqual(opened.data.stacks, stacks, 'PROFILE-ACTUAL-FRONTEND-STACKS');
  assert.deepEqual(opened.data.quality, quality, 'PROFILE-ACTUAL-FRONTEND-STACK-QUALITY');
  assert.equal(opened.data.frames.length, scenario.frame ? 1 : 0);
  if (scenario.frame) {
    const frame = opened.data.frames[0];
    assert.deepEqual(
      Buffer.from(await frame.content.arrayBuffer()),
      scenario.frame_bytes,
      'PROFILE-MEDIA-ACTUAL-FRONTEND-FRAME',
    );
  }
  assert.equal(opened.data.perf !== null, captured);
  if (captured) assert.deepEqual(Buffer.from(await opened.data.perf.arrayBuffer()), rawPerfBytes);
  assert.deepEqual(
    opened.data.timeline.samples[0].stacks.map((value) => value.index),
    captured ? [0, 1] : [],
  );
  assert.deepEqual(
    opened.data.timeline.unassociated.map((value) => value.index),
    captured ? [2, 3] : [],
  );
  report.profiles ??= [];
  report.profiles.push({
    case_id: scenario.id,
    result,
    index,
    stacks,
    quality,
    flamegraph,
    archive_members: [...files.keys()],
    frontend_consumed: true,
    unassociated_indices: opened.data.timeline.unassociated.map((value) => value.index),
  });
}
