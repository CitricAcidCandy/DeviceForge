import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// 独立按 Android 官方 cmd_report_sample.proto 编码，不导入生产解析器。
export const schemaSource = 'https://android.googlesource.com/platform/system/extras/+/refs/heads/main/simpleperf/cmd_report_sample.proto';
export const packageName = 'org.smoke.profile.game';
export const targetPid = 2468;
export const targetUid = 10123;
export const processStartTicks = '900';

function varint(value) {
  let remaining = BigInt.asUintN(64, BigInt(value)); const bytes = [];
  do { let byte = Number(remaining & 127n); remaining >>= 7n; if (remaining) byte |= 128; bytes.push(byte); } while (remaining);
  return Buffer.from(bytes);
}
const integer = (field, value) => Buffer.concat([varint(field << 3), varint(value)]);
const bytes = (field, value) => { const content = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  return Buffer.concat([varint((field << 3) | 2), varint(content.length), content]); };
const chainEntry = (address, fileId, symbolId) => Buffer.concat([integer(1, address), integer(2, fileId), integer(3, symbolId), integer(4, 0)]);
function sample(timeNs, ordinal) {
  const chain = [chainEntry(4096n + BigInt(ordinal), 0, ordinal === 1 ? -1 : 0), chainEntry(8192n + BigInt(ordinal), 1, 0)];
  return bytes(1, Buffer.concat([integer(1, timeNs), integer(2, targetPid + ordinal % 2), ...chain.map(entry => bytes(3, entry)), integer(4, 7 + ordinal), integer(5, 0)]));
}
const record = payload => { const length = Buffer.alloc(4); length.writeUInt32LE(payload.length); return Buffer.concat([length, payload]); };
export function reportBytes(times = [10500123456n, 10050123456n, 10050123456n, 11000123456n]) {
  assert.equal(times.length, 4, 'PROFILE-GOLDEN-FOUR-SAMPLES');
  assert.ok(times.every(value => BigInt(value) >= 0n && BigInt(value) <= 0xffffffffffffffffn), 'PROFILE-GOLDEN-TIME-RANGE');
  const records = times.map((time, ordinal) => sample(BigInt(time), ordinal));
  // 符号表和线程表故意放在样本之后；同时间两个样本按原顺序稳定排序。
  records.push(bytes(2, Buffer.concat([integer(1, 4), integer(2, 2)])));
  records.push(bytes(3, Buffer.concat([integer(1, 0), bytes(2, '/data/app/org.smoke.profile.game/lib/arm64/libgame.so'), bytes(3, '游戏更新'), bytes(4, '_Z10GameUpdatev')])));
  records.push(bytes(3, Buffer.concat([integer(1, 1), bytes(2, '/system/lib64/libc.so'), bytes(3, '__start_thread'), bytes(4, '__start_thread')])));
  records.push(bytes(4, Buffer.concat([integer(1, targetPid), integer(2, targetPid), bytes(3, '游戏主线程')])));
  records.push(bytes(4, Buffer.concat([integer(1, targetPid + 1), integer(2, targetPid), bytes(3, '游戏工作线程')])));
  records.push(bytes(5, Buffer.concat([bytes(1, 'cpu-clock'), bytes(2, packageName), bytes(3, 'non_profileable'), bytes(4, '31'), bytes(5, 'userdebug')])));
  const version = Buffer.alloc(2); version.writeUInt16LE(1);
  return Buffer.concat([Buffer.from('SIMPLEPERF', 'ascii'), version, ...records.map(record), Buffer.alloc(4)]);
}
export function expectedStacks(times = [10500123456n, 10050123456n, 10050123456n, 11000123456n]) {
  return times.map((time, ordinal) => ({ time_ns: BigInt(time).toString(), ordinal, pid: targetPid, tid: targetPid + ordinal % 2,
    thread: ordinal % 2 ? '游戏工作线程' : '游戏主线程', event_type: 'cpu-clock', event_count: String(7 + ordinal),
    leaf_address: String(4096 + ordinal), leaf_symbol: ordinal === 1 ? null : '游戏更新',
    caller_address: String(8192 + ordinal), caller_symbol: '__start_thread' }))
    .sort((left, right) => BigInt(left.time_ns) < BigInt(right.time_ns) ? -1 : BigInt(left.time_ns) > BigInt(right.time_ns) ? 1 : left.ordinal - right.ordinal);
}
export const rawPerfBytes = Buffer.from('DEVICEFORGE_PROFILE_GOLDEN_RAW_TRACE\0v1', 'utf8');
// 合法的一像素 PNG；验收只核采样画面原字节和关联，不据此作视觉结论。
export const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
export const sha256 = value => createHash('sha256').update(value).digest('hex');
