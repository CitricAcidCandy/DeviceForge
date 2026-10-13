import assert from 'node:assert/strict';

// 独立只验 Stored ZIP；范围、名称、CRC 与 local/central 对应均从原字节核对。
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
const decoder = new TextDecoder('utf-8', { fatal: true });
function nameOf(bytes) {
  const name = decoder.decode(bytes);
  assert.ok(name.length > 0 && name.length <= 128 && !/[\\\x00:]/.test(name) && !name.startsWith('/'), 'PROFILE-ZIP-NAME');
  assert.ok(name.split('/').every(part => part && part !== '.' && part !== '..'), 'PROFILE-ZIP-NAME-SEGMENTS');
  return name;
}
export function storedEntries(bytes) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length >= 22 && bytes.length <= 64 * 1024 * 1024, 'PROFILE-ZIP-BYTES');
  const lower = Math.max(0, bytes.length - 65557); let end = bytes.length - 22;
  while (end >= lower && (bytes.readUInt32LE(end) !== 0x06054b50 || end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length)) end--;
  assert.ok(end >= lower, 'PROFILE-ZIP-EOCD');
  assert.equal(bytes.readUInt16LE(end + 4), 0, 'PROFILE-ZIP-DISK');
  assert.equal(bytes.readUInt16LE(end + 6), 0, 'PROFILE-ZIP-CENTRAL-DISK');
  const count = bytes.readUInt16LE(end + 10), centralSize = bytes.readUInt32LE(end + 12), centralStart = bytes.readUInt32LE(end + 16);
  assert.equal(bytes.readUInt16LE(end + 8), count, 'PROFILE-ZIP-DISK-ENTRY-COUNT');
  assert.ok(count >= 1 && count <= 64 && centralStart + centralSize === end, 'PROFILE-ZIP-CENTRAL-RANGE');
  const result = new Map(), ranges = []; let cursor = centralStart, expanded = 0;
  for (let index = 0; index < count; index++) {
    assert.ok(cursor + 46 <= end, 'PROFILE-ZIP-CENTRAL-HEADER-BOUND');
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50, 'PROFILE-ZIP-CENTRAL-SIGNATURE');
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), crc = bytes.readUInt32LE(cursor + 16);
    const compressed = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24);
    const nameSize = bytes.readUInt16LE(cursor + 28), extraSize = bytes.readUInt16LE(cursor + 30), commentSize = bytes.readUInt16LE(cursor + 32);
    const local = bytes.readUInt32LE(cursor + 42);
    assert.equal(flags & ~0x0800, 0, 'PROFILE-ZIP-UNSUPPORTED-FLAGS'); assert.equal(method, 0, 'PROFILE-ZIP-STORED');
    assert.equal(bytes.readUInt16LE(cursor + 34), 0, 'PROFILE-ZIP-ENTRY-DISK');
    assert.ok(size <= 64 * 1024 * 1024 && compressed === size && extraSize <= 4096 && commentSize <= 4096, 'PROFILE-ZIP-ENTRY-LIMIT');
    assert.ok(cursor + 46 + nameSize + extraSize + commentSize <= end, 'PROFILE-ZIP-CENTRAL-NAME-BOUND');
    const centralName = bytes.subarray(cursor + 46, cursor + 46 + nameSize), name = nameOf(centralName);
    assert.ok(!result.has(name), 'PROFILE-ZIP-NO-DUPLICATE');
    assert.ok(local + 30 <= centralStart, 'PROFILE-ZIP-LOCAL-HEADER-BOUND');
    assert.equal(bytes.readUInt32LE(local), 0x04034b50, 'PROFILE-ZIP-LOCAL-SIGNATURE');
    assert.equal(bytes.readUInt16LE(local + 6), flags, 'PROFILE-ZIP-LOCAL-FLAGS');
    assert.equal(bytes.readUInt16LE(local + 8), method, 'PROFILE-ZIP-LOCAL-METHOD');
    assert.equal(bytes.readUInt32LE(local + 14), crc, 'PROFILE-ZIP-LOCAL-CRC');
    assert.equal(bytes.readUInt32LE(local + 18), compressed, 'PROFILE-ZIP-LOCAL-COMPRESSED-SIZE');
    assert.equal(bytes.readUInt32LE(local + 22), size, 'PROFILE-ZIP-LOCAL-SIZE');
    const localNameSize = bytes.readUInt16LE(local + 26), localExtraSize = bytes.readUInt16LE(local + 28);
    const dataStart = local + 30 + localNameSize + localExtraSize, dataEnd = dataStart + size;
    assert.ok(localExtraSize <= 4096 && dataEnd <= centralStart, 'PROFILE-ZIP-LOCAL-DATA-BOUND');
    assert.deepEqual(bytes.subarray(local + 30, local + 30 + localNameSize), centralName, 'PROFILE-ZIP-LOCAL-NAME');
    const content = bytes.subarray(dataStart, dataEnd); assert.equal(crc32(content), crc, 'PROFILE-ZIP-CRC');
    expanded += size; assert.ok(expanded <= 64 * 1024 * 1024, 'PROFILE-ZIP-TOTAL-BOUND');
    ranges.push({ begin: local, end: dataEnd }); result.set(name, content);
    cursor += 46 + nameSize + extraSize + commentSize;
  }
  assert.equal(cursor, end, 'PROFILE-ZIP-CENTRAL-COMPLETE');
  ranges.sort((left, right) => left.begin - right.begin); let next = 0;
  for (const range of ranges) { assert.equal(range.begin, next, 'PROFILE-ZIP-NO-HIDDEN-OR-OVERLAP'); next = range.end; }
  assert.equal(next, centralStart, 'PROFILE-ZIP-LOCAL-COMPLETE');
  return result;
}
