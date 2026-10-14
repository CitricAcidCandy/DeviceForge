import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';

function crc32(bytes) {
  let checksum = 0xffffffff;
  for (const byte of bytes) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit++) checksum = (checksum >>> 1) ^ (checksum & 1 ? 0xedb88320 : 0);
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

export function entries(bytes) {
  assert.ok(bytes.length >= 22 && bytes.length <= 1024 * 1024);
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  assert.equal(bytes.readUInt16LE(end + 20), 0);
  const count = bytes.readUInt16LE(end + 10),
    size = bytes.readUInt32LE(end + 12);
  let cursor = bytes.readUInt32LE(end + 16);
  const indexEnd = cursor + size,
    found = new Map();
  assert.ok(count > 0 && count <= 16 && indexEnd === end);
  for (let ordinal = 0; ordinal < count; ordinal++) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
    const method = bytes.readUInt16LE(cursor + 10),
      crc = bytes.readUInt32LE(cursor + 16);
    const compressed = bytes.readUInt32LE(cursor + 20),
      length = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28),
      extra = bytes.readUInt16LE(cursor + 30),
      comment = bytes.readUInt16LE(cursor + 32);
    const local = bytes.readUInt32LE(cursor + 42);
    const name = new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(cursor + 46, cursor + 46 + nameLength),
    );
    assert.ok(!found.has(name) && length <= 65536 && [0, 8].includes(method));
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    assert.equal(bytes.readUInt16LE(local + 8), method);
    const offset = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    assert.ok(offset + compressed <= bytes.readUInt32LE(end + 16));
    const content =
      method === 0
        ? bytes.subarray(offset, offset + compressed)
        : inflateRawSync(bytes.subarray(offset, offset + compressed), { maxOutputLength: 65536 });
    assert.equal(content.length, length);
    assert.equal(crc32(content), crc);
    found.set(name, content);
    cursor += 46 + nameLength + extra + comment;
  }
  assert.equal(cursor, indexEnd);
  return found;
}

export function readEntry(bytes, target, limit = 16384) {
  assert.ok(bytes.length <= 32 * 1024 * 1024);
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  assert.ok(end >= 0 && end + 22 + bytes.readUInt16LE(end + 20) === bytes.length);
  const count = bytes.readUInt16LE(end + 10);
  assert.ok(count <= 50000);
  let cursor = bytes.readUInt32LE(end + 16);
  for (let ordinal = 0; ordinal < count; ordinal++) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
    const nameLength = bytes.readUInt16LE(cursor + 28),
      extra = bytes.readUInt16LE(cursor + 30),
      comment = bytes.readUInt16LE(cursor + 32);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (name === target) {
      const local = bytes.readUInt32LE(cursor + 42),
        method = bytes.readUInt16LE(cursor + 10);
      const length = bytes.readUInt32LE(cursor + 24),
        compressed = bytes.readUInt32LE(cursor + 20);
      assert.ok(length <= limit && [0, 8].includes(method));
      assert.equal(bytes.readUInt32LE(local), 0x04034b50);
      const offset = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      const result =
        method === 0
          ? bytes.subarray(offset, offset + compressed)
          : inflateRawSync(bytes.subarray(offset, offset + compressed), { maxOutputLength: limit });
      assert.equal(result.length, length);
      assert.equal(crc32(result), bytes.readUInt32LE(cursor + 16));
      return result;
    }
    cursor += 46 + nameLength + extra + comment;
  }
  return null;
}
