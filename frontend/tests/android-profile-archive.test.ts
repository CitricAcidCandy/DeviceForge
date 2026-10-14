import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { openProfileArchive, downloadAndOpenProfileArchive, buildProfileFolded, decodeProfileFolded, PROFILE_FOLDED_LIMITS, PROFILE_LIMITS } from '../src/features/android-profile/index.ts';
import type { ProfileResult, StackSample } from '../src/features/android-profile/index.ts';
import { ApiError } from '../src/shared/api/index.ts';
import type { ArtifactDto } from '../src/shared/api/index.ts';
import { signal } from './fixtures.ts';

interface FixtureFile { readonly name: string; readonly bytes: Uint8Array }
function checksum(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? crc >>> 1 ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function join(chunks: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0)); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
function chunk(kind: string, data: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(data.length + 12); const view = new DataView(bytes.buffer);
  view.setUint32(0, data.length); bytes.set(new TextEncoder().encode(kind), 4); bytes.set(data, 8);
  view.setUint32(data.length + 8, checksum(bytes.subarray(4, data.length + 8))); return bytes;
}
function png(): Uint8Array {
  const header = new Uint8Array(13); const view = new DataView(header.buffer);
  view.setUint32(0, 1); view.setUint32(4, 1); header[8] = 8; header[9] = 6;
  return join([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(new Uint8Array([0, 0, 0, 0, 255]))), chunk('IEND', new Uint8Array())]);
}
function zip(files: readonly FixtureFile[]) {
  const locals: Uint8Array[] = []; const centrals: Uint8Array[] = []; const positions: { name: string; data: number; local: number; central: number }[] = [];
  let offset = 0; let centralLength = 0;
  for (const file of files) {
    const name = new TextEncoder().encode(file.name); const crc = checksum(file.bytes);
    const local = new Uint8Array(30 + name.length + file.bytes.length); const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true); localView.setUint16(4, 20, true); localView.setUint16(6, 0x0800, true);
    localView.setUint32(14, crc, true); localView.setUint32(18, file.bytes.length, true); localView.setUint32(22, file.bytes.length, true);
    localView.setUint16(26, name.length, true); local.set(name, 30); local.set(file.bytes, 30 + name.length);
    const central = new Uint8Array(46 + name.length); const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true); centralView.setUint16(4, 20, true); centralView.setUint16(6, 20, true); centralView.setUint16(8, 0x0800, true);
    centralView.setUint32(16, crc, true); centralView.setUint32(20, file.bytes.length, true); centralView.setUint32(24, file.bytes.length, true);
    centralView.setUint16(28, name.length, true); centralView.setUint32(42, offset, true); central.set(name, 46);
    positions.push({ name: file.name, data: offset + 30 + name.length, local: offset, central: centralLength });
    locals.push(local); centrals.push(central); offset += local.length; centralLength += central.length;
  }
  const end = new Uint8Array(22); const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true); endView.setUint16(8, files.length, true); endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralLength, true); endView.setUint32(16, offset, true);
  return { bytes: join([...locals, ...centrals, end]), entries: positions.map((entry) => ({ ...entry, central: entry.central + offset })) };
}
function result(): ProfileResult {
  return { format_version: 1, device_id: 'emulator-5554', package: 'com.example.game', pid: 42, process_start_ticks: '900', clock: 'boottime',
    root_access: 'su', stack_status: 'captured', stack_reason: null, frame_kind: 'sampled_screenshot', display_frame_complete: false,
    sample_count: 1, stack_sample_count: 1, lost_count: '0', frame_count: 1, index_filename: 'profile-index.json', archive_filename: 'profile.zip' };
}
function index() {
  const { sample_count, frame_count, index_filename, archive_filename, ...identity } = result(); assert.ok(sample_count && frame_count && index_filename && archive_filename);
  return { ...identity, symbolication: 'reported_symbols_only', samples: [{ index: 0, begin_ns: '100', end_ns: '200',
    metrics: { captured_at: 1000, pid: 42, process_start_ticks: 900, process_ticks: 100, system_ticks: 1000, logical_cpus: 8, pss_kib: 100 },
    frame: { index: 0, filename: 'frames/000000.png', begin_ns: '120', end_ns: '150' }, stack_sample_indices: [0] }] };
}
function stack(): StackSample {
  return { time_ns: '130', thread_id: 43, process_id: 42, thread_name: 'Main', event_count: '1', event_type: 'cpu-clock',
    callchain: [{ file: 'libgame.so', symbol: null, address: '0x1234', execution_type: 'native' }], unwinding: null };
}
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
function files(): FixtureFile[] {
  return [{ name: 'profile-index.json', bytes: json(index()) }, { name: 'stacks.jsonl', bytes: json(stack()) },
    { name: 'perf.bin', bytes: new Uint8Array([1, 2, 3]) }, { name: 'frames/000000.png', bytes: png() }];
}
function expectedCode(code: string) { return (error: unknown) => error instanceof ApiError && error.code === code && error.logId === 'archive-log'; }

test('Stored归档联合交付同录制索引、未知符号堆栈、PNG与trace，画面可直接取用', async () => {
  const opened = openProfileArchive(zip(files()).bytes, result(), 'archive-log');
  assert.equal(opened.folded, null);
  assert.equal(opened.index.pid, 42); assert.equal(opened.stacks[0]?.callchain[0]?.symbol, null);
  assert.equal(opened.timeline.samples[0]?.frameStacks[0]?.index, 0);
  assert.equal(opened.frames[0]?.width, 1); assert.equal(opened.frames[0]?.height, 1); assert.equal(opened.frames[0]?.content.type, 'image/png');
  const frame = opened.frames[0]; assert.ok(frame); assert.ok(opened.perf);
  assert.deepEqual(new Uint8Array(await frame.content.arrayBuffer()), png());
  assert.deepEqual(new Uint8Array(await opened.perf.arrayBuffer()), new Uint8Array([1, 2, 3]));
});

test('数据CRC损坏、重复、Deflate、descriptor及central/local不一致明确拒绝', () => {
  const fixture = zip(files()); const first = fixture.entries[0]; assert.ok(first);
  const corrupt = Uint8Array.from(fixture.bytes); corrupt[first.data] = (corrupt[first.data] ?? 0) ^ 1;
  assert.throws(() => openProfileArchive(corrupt, result(), 'archive-log'), expectedCode('profile_zip_crc_mismatch'));
  assert.throws(() => openProfileArchive(zip([...files(), files()[0] ?? { name: '', bytes: new Uint8Array() }]).bytes, result(), 'archive-log'), expectedCode('duplicate_profile_zip_entry'));
  const compressed = Uint8Array.from(fixture.bytes); new DataView(compressed.buffer).setUint16(first.central + 10, 8, true);
  assert.throws(() => openProfileArchive(compressed, result(), 'archive-log'), expectedCode('unsupported_profile_zip_compression'));
  const descriptor = Uint8Array.from(fixture.bytes); new DataView(descriptor.buffer).setUint16(first.central + 8, 0x0808, true);
  assert.throws(() => openProfileArchive(descriptor, result(), 'archive-log'), expectedCode('unsupported_profile_zip_flags'));
  const mismatched = Uint8Array.from(fixture.bytes); new DataView(mismatched.buffer).setUint32(first.local + 14, 0, true);
  assert.throws(() => openProfileArchive(mismatched, result(), 'archive-log'), expectedCode('invalid_profile_zip_local'));
});

test('缺少引用帧、孤儿帧、索引错进程及越区间关联不交付部分归档', () => {
  assert.throws(() => openProfileArchive(zip(files().filter((file) => !file.name.startsWith('frames/'))).bytes, result(), 'archive-log'), expectedCode('missing_profile_archive_entry'));
  assert.throws(() => openProfileArchive(zip([...files(), { name: 'frames/000001.png', bytes: png() }]).bytes, result(), 'archive-log'), expectedCode('unexpected_profile_archive_entry'));
  assert.throws(() => openProfileArchive(zip(files().map((file) => file.name === 'profile-index.json' ? { ...file, bytes: json({ ...index(), pid: 99 }) } : file)).bytes, result(), 'archive-log'), expectedCode('invalid_android_profile_result'));
  assert.throws(() => openProfileArchive(zip(files().map((file) => file.name === 'stacks.jsonl' ? { ...file, bytes: json({ ...stack(), time_ns: '201' }) } : file)).bytes, result(), 'archive-log'), expectedCode('invalid_android_profile_result'));
});

test('PNG内部CRC与尺寸容器必须有效，不只校验文件扩展名', () => {
  const invalid = png(); invalid[20] = (invalid[20] ?? 0) ^ 1;
  assert.throws(() => openProfileArchive(zip(files().map((file) => file.name.startsWith('frames/') ? { ...file, bytes: invalid } : file)).bytes, result(), 'archive-log'), expectedCode('profile_png_crc_mismatch'));
  const signatureOnly = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  assert.throws(() => openProfileArchive(zip(files().map((file) => file.name.startsWith('frames/') ? { ...file, bytes: signatureOnly } : file)).bytes, result(), 'archive-log'), expectedCode('invalid_profile_png'));
});

test('ZIP拒越界、隐藏字节、非法路径与声明过量输出', () => {
  const fixture = zip(files()); const first = fixture.entries[0]; assert.ok(first);
  assert.throws(() => openProfileArchive(fixture.bytes.subarray(0, fixture.bytes.length - 1), result(), 'archive-log'), expectedCode('invalid_profile_zip_end'));
  assert.throws(() => openProfileArchive(join([fixture.bytes, new Uint8Array([0])]), result(), 'archive-log'), expectedCode('invalid_profile_zip_end'));
  assert.throws(() => openProfileArchive(zip([...files(), { name: '../outside.png', bytes: png() }]).bytes, result(), 'archive-log'), expectedCode('invalid_profile_zip_name'));
  const overflow = Uint8Array.from(fixture.bytes); const view = new DataView(overflow.buffer);
  view.setUint32(first.central + 20, PROFILE_LIMITS.archiveBytes + 1, true); view.setUint32(first.central + 24, PROFILE_LIMITS.archiveBytes + 1, true);
  assert.throws(() => openProfileArchive(overflow, result(), 'archive-log'), expectedCode('invalid_profile_zip_size'));
  const cancelled = new AbortController(); cancelled.abort();
  assert.throws(() => openProfileArchive(fixture.bytes, result(), 'archive-log', cancelled.signal), (error: unknown) => error instanceof ApiError && error.kind === 'cancelled' && error.logId === 'archive-log');
});

test('无Root归档保留空stacks与可取画面，不要求perf也不允许伪装trace', () => {
  const unavailable: ProfileResult = { ...result(), root_access: 'none', stack_status: 'unavailable', stack_reason: 'root_unavailable', stack_sample_count: 0 };
  const value = index(); const row = value.samples[0]; assert.ok(row);
  const noRootIndex = { ...value, root_access: 'none', stack_status: 'unavailable', stack_reason: 'root_unavailable', stack_sample_count: 0, samples: [{ ...row, stack_sample_indices: [] }] };
  const noRootFiles = files().filter((file) => file.name !== 'perf.bin').map((file) => file.name === 'profile-index.json' ? { ...file, bytes: json(noRootIndex) } : file.name === 'stacks.jsonl' ? { ...file, bytes: new Uint8Array() } : file);
  const opened = openProfileArchive(zip(noRootFiles).bytes, unavailable, 'archive-log');
  assert.equal(opened.folded, null);
  assert.throws(() => openProfileArchive(zip([...noRootFiles, { name: 'flamegraph.folded', bytes: new Uint8Array() }]).bytes, unavailable, 'archive-log'), expectedCode('unexpected_profile_folded'));
  assert.equal(opened.perf, null); assert.equal(opened.frames.length, 1); assert.equal(opened.stacks.length, 0); assert.equal(opened.timeline.stackStatus, 'unavailable');
  assert.throws(() => openProfileArchive(zip([...noRootFiles, { name: 'perf.bin', bytes: new Uint8Array([1]) }]).bytes, unavailable, 'archive-log'), expectedCode('unexpected_profile_archive_entry'));
});

async function artifact(filename: string, bytes: Uint8Array): Promise<ArtifactDto> {
  const hash = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
  return { id: filename, filename, media_type: filename.endsWith('.json') ? 'application/json' : 'application/zip', size: bytes.length, created_at: 1,
    sha256: Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('') };
}
test('联合下载先核ZIP摘要，归档内索引也须匹配独立发布索引并保留下载日志', async () => {
  const fixture = zip(files()); const published = { result: result(), artifacts: [await artifact('profile-index.json', json(index())), await artifact('profile.zip', fixture.bytes)] };
  const calls: string[] = [];
  const reader = { download: async (id: string) => { calls.push(id); return { data: new Blob([Uint8Array.from(fixture.bytes)]), logId: 'archive-download' }; } };
  const opened = await downloadAndOpenProfileArchive(reader, published, signal());
  assert.equal(opened.logId, 'archive-download'); assert.equal(opened.data.frames.length, 1); assert.deepEqual(calls, ['profile.zip']);
  const corrupted = Uint8Array.from(fixture.bytes); corrupted[0] = 0;
  await assert.rejects(downloadAndOpenProfileArchive({ download: async () => ({ data: new Blob([corrupted]), logId: 'archive-download' }) }, published, signal()),
    (error: unknown) => error instanceof ApiError && error.code === 'artifact_digest_mismatch' && error.logId === 'archive-download');
  const differentIndex = Uint8Array.from(json(index())); differentIndex[0] = 32;
  const mismatched = { ...published, artifacts: [await artifact('profile-index.json', differentIndex), published.artifacts[1] ?? await artifact('profile.zip', fixture.bytes)] };
  await assert.rejects(downloadAndOpenProfileArchive(reader, mismatched, signal()), (error: unknown) => error instanceof ApiError && error.code === 'artifact_digest_mismatch' && error.logId === 'archive-download');
});

test('scrcpy终态归档直接提供选择时差、原PTS和对应PNG，不改用宿主墙钟', () => {
  const current: ProfileResult = { ...result(), frame_kind: 'scrcpy_sampled_frame', frame_status: 'captured', frame_reason: null };
  const value = index(); const row = value.samples[0]; assert.ok(row);
  const next = { ...value, frame_kind: 'scrcpy_sampled_frame', frame_status: 'captured', frame_reason: null, samples: [{ ...row, target_ns: '150',
    frame: { ...row.frame, source: 'scrcpy', epoch: 1, video_frame_index: 7, pts_us: '90071992547409930', device_time_ns: '130', selection_delta_ns: '-20', clock_error_ns: '10', end_ns: '140' } }] };
  const archived = zip(files().map((file) => file.name === 'profile-index.json' ? { ...file, bytes: json(next) } : file));
  const opened = openProfileArchive(archived.bytes, current, 'archive-log');
  assert.equal(opened.frames[0]?.reference.selection_delta_ns, '-20'); assert.equal(opened.frames[0]?.reference.pts_us, '90071992547409930');
  assert.equal(opened.timeline.frameKind, 'scrcpy_sampled_frame'); assert.equal(opened.timeline.samples[0]?.frameStacks[0]?.index, 0);
});

test('稀疏采样画面沿sample编号交付，前一个无近邻不会拒绝后续PNG', () => {
  const value = index(); const row = value.samples[0]; assert.ok(row);
  const current: ProfileResult = { ...result(), sample_count: 2, frame_count: 1 };
  const later = { ...row, index: 1, begin_ns: '210', end_ns: '300', frame: { ...row.frame, index: 1, filename: 'frames/000001.png', begin_ns: '230', end_ns: '260' }, stack_sample_indices: [] };
  const sparse = { ...value, samples: [{ ...row, frame: null }, later] };
  const archived = zip(files().map((file) => file.name === 'profile-index.json' ? { ...file, bytes: json(sparse) } : file.name.startsWith('frames/') ? { ...file, name: 'frames/000001.png' } : file));
  const opened = openProfileArchive(archived.bytes, current, 'archive-log');
  assert.equal(opened.frames.length, 1); assert.equal(opened.frames[0]?.reference.index, 1);
  assert.equal(opened.frames[0]?.reference.filename, 'frames/000001.png'); assert.equal(opened.timeline.samples[0]?.sample.frame, null);
});

function qualityFixture() {
  return { format_version: 1, capture: { mode: 'dwarf', event: 'cpu-clock', frequency_hz: 99, clock: 'boottime', report_filter: 'disabled', remove_gaps: 0 },
    counts: { reported_sample_count: '1', parsed_sample_count: '1', lost_count: '0', callchain_frame_count: 1, empty_callchain_sample_count: 0, single_frame_sample_count: 1, max_callchain_depth: 1, unwinding_error_sample_count: 0, unwinding_without_error_sample_count: 0, unwinding_metadata_missing_sample_count: 1, missing_symbol_frame_count: 1, missing_symbol_sample_count: 1 },
    depth_histogram: [{ depth: 1, count: 1 }], unwinding_error_histogram: [],
    architecture: { status: 'unavailable', device_arch: null, target_process_arch: null, reason: '报告没有目标架构证据' },
    symbolication: { status: 'reported_symbols_only', build_id_status: 'unavailable', reason: '报告没有构建标识' } };
}
test('可选质量文件保留缺符号与缺错误元数据，旧归档缺省兼容', () => {
  assert.equal(openProfileArchive(zip(files()).bytes, result(), 'archive-log').quality, null);
  const quality = qualityFixture();
  const opened = openProfileArchive(zip([...files(), { name: 'stack-quality.json', bytes: json(quality) }]).bytes, result(), 'archive-log');
  assert.deepEqual(opened.quality, quality);
});
test('质量汇总与原栈矛盾、重复直方图、未知模式及过限质量文件全部拒绝', () => {
  const quality = qualityFixture();
  const invalid = [
    { ...quality, counts: { ...quality.counts, missing_symbol_frame_count: 0 } },
    { ...quality, counts: { ...quality.counts, parsed_sample_count: '2' } },
    { ...quality, depth_histogram: [{ depth: 1, count: 1 }, { depth: 1, count: 1 }] },
    { ...quality, capture: { ...quality.capture, report_filter: 'default' } },
    { ...quality, unwinding_error_histogram: [{ raw_error_code: 0, error_code: null, count: 1 }] },
  ];
  for (const value of invalid) assert.throws(() => openProfileArchive(zip([...files(), { name: 'stack-quality.json', bytes: json(value) }]).bytes, result(), 'archive-log'), expectedCode('invalid_android_profile_result'));
  assert.throws(() => openProfileArchive(zip([...files(), { name: 'stack-quality.json', bytes: new Uint8Array(PROFILE_LIMITS.indexBytes + 1) }]).bytes, result(), 'archive-log'), expectedCode('invalid_profile_zip_size'));
});
test('错误质量直方图保留原码并且不能把错误样本声明为完整展开', () => {
  const quality = qualityFixture();
  const value = { ...quality, counts: { ...quality.counts, unwinding_error_sample_count: 1, unwinding_metadata_missing_sample_count: 0 }, unwinding_error_histogram: [{ raw_error_code: 7, error_code: 0, count: 1 }] };
  const inputs = files().map(file => file.name === 'stacks.jsonl' ? { ...file, bytes: json({ ...stack(), unwinding: { raw_error_code: 7, error_code: 0, error_address: '0x1234' } }) } : file);
  const opened = openProfileArchive(zip([...inputs, { name: 'stack-quality.json', bytes: json(value) }]).bytes, result(), 'archive-log');
  assert.equal(opened.quality?.unwinding_error_histogram[0]?.raw_error_code, 7);
  assert.throws(() => openProfileArchive(zip([...inputs, { name: 'stack-quality.json', bytes: json(quality) }]).bytes, result(), 'archive-log'), expectedCode('invalid_android_profile_result'));
});

const foldedFixtureText = 'event="cpu-clock";pid=42;tid=43;["native","libgame.so",null,"0x1234"] 1\n';
const textBytes = (text: string) => new TextEncoder().encode(text);
test('可选folded与同一原栈严格一致后交付原字节Blob，旧Root归档仍兼容', async () => {
  assert.equal(buildProfileFolded([stack()]), foldedFixtureText);
  const opened = openProfileArchive(zip([...files(), { name: 'flamegraph.folded', bytes: textBytes(foldedFixtureText) }]).bytes, result(), 'archive-log');
  assert.ok(opened.folded);
  assert.equal(opened.folded.type, 'text/plain;charset=utf-8');
  assert.deepEqual(new Uint8Array(await opened.folded.arrayBuffer()), textBytes(foldedFixtureText));
  const emptyStack = { ...stack(), callchain: [] };
  const emptyInputs = files().map(file => file.name === 'stacks.jsonl' ? { ...file, bytes: json(emptyStack) } : file);
  const empty = openProfileArchive(zip([...emptyInputs, { name: 'flamegraph.folded', bytes: new Uint8Array() }]).bytes, result(), 'archive-log');
  assert.equal(empty.folded?.size, 0);
});

test('folded拒绝错计数、漏换行、额外路径、未知符号改大小写与非规范UTF8', () => {
  for (const text of [foldedFixtureText.replace(' 1\n', ' 2\n'), foldedFixtureText.trimEnd(),
    foldedFixtureText + foldedFixtureText, foldedFixtureText.replace('0x1234', '0x001234'),
    '\ufeff' + foldedFixtureText]) {
    assert.throws(() => openProfileArchive(zip([...files(), { name: 'flamegraph.folded', bytes: textBytes(text) }]).bytes, result(), 'archive-log'), expectedCode('profile_folded_mismatch'));
  }
  assert.throws(() => openProfileArchive(zip([...files(), { name: 'flamegraph.folded', bytes: new Uint8Array([255]) }]).bytes, result(), 'archive-log'), expectedCode('invalid_profile_folded_utf8'));
});

test('folded采用后端原地址文本、逐标签转义、根到叶顺序与已知函数合并地址', () => {
  const first: StackSample = { ...stack(), event_type: 'cpu;%clock', process_id: null, thread_id: 9, callchain: [
    { file: 'x;y%z', symbol: '', address: '0x00Aa', execution_type: 'native' },
    { file: 'root.so', symbol: 'root;%fn', address: '0x1', execution_type: 'art' }] };
  const second: StackSample = { ...first, callchain: [first.callchain[0] ?? stack().callchain[0] ?? { file: null, symbol: null, address: '0x0', execution_type: 'native' },
    { file: 'root.so', symbol: 'root;%fn', address: '0x2', execution_type: 'art' }] };
  const expected = 'event="cpu%3B%25clock";pid=null;tid=9;["art","root.so","root%3B%25fn",null];["native","x%3By%25z",null,"0x00Aa"] 2\n';
  assert.equal(buildProfileFolded([first, second, { ...stack(), callchain: [] }]), expected);
});

test('folded完整key采用UTF8字节顺序，补充平面符号不按UTF16顺序排列', () => {
  const known = (symbol: string): StackSample => ({ ...stack(), callchain: [{ file: 'same.so', symbol, address: '0x1', execution_type: 'native' }] });
  const expected = 'event="cpu-clock";pid=42;tid=43;["native","same.so","\ue000",null] 1\n'
    + 'event="cpu-clock";pid=42;tid=43;["native","same.so","\ud800\udc00",null] 1\n';
  assert.equal(buildProfileFolded([known('\ud800\udc00'), known('\ue000')]), expected);
});

test('folded输出及ZIP声明限制为32MiB，取消保留归档日志且不交付部分结果', () => {
  assert.throws(() => decodeProfileFolded(new Uint8Array(PROFILE_FOLDED_LIMITS.bytes + 1), result(), [stack()], 'archive-log'), expectedCode('invalid_profile_folded_size'));
  const archive = zip([...files(), { name: 'flamegraph.folded', bytes: new Uint8Array() }]); const folded = archive.entries.find(entry => entry.name === 'flamegraph.folded'); assert.ok(folded);
  const declared = Uint8Array.from(archive.bytes); const view = new DataView(declared.buffer);
  view.setUint32(folded.central + 20, PROFILE_FOLDED_LIMITS.bytes + 1, true); view.setUint32(folded.central + 24, PROFILE_FOLDED_LIMITS.bytes + 1, true);
  assert.throws(() => openProfileArchive(declared, result(), 'archive-log'), expectedCode('invalid_profile_zip_size'));
  const cancelled = new AbortController(); cancelled.abort();
  assert.throws(() => decodeProfileFolded(textBytes(foldedFixtureText), result(), [stack()], 'archive-log', cancelled.signal),
    (error: unknown) => error instanceof ApiError && error.kind === 'cancelled' && error.logId === 'archive-log');
});
