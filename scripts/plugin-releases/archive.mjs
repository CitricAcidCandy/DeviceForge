// 有界检查 ZIP/TGZ 普通文件；离线 ZIP 使用存储模式，避免引入分发依赖。
import { open, readFile, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createGunzip, gzipSync } from 'node:zlib';
import { relativePath, RESOURCE_LIMIT } from './contract.mjs';

const table = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crcUpdate(crc, data) {
  for (const byte of data) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  return crc;
}
const crc32 = (data) => (crcUpdate(0xffffffff, data) ^ 0xffffffff) >>> 0;
const fail = (condition, message) => {
  if (!condition) throw new Error(message);
};
const TOTAL_LIMIT = 1024 * 1024 * 1024;

export async function writeZip(destination, members) {
  fail(members.length > 0 && members.length <= 512, '离线资源成员数量无效');
  const output = await open(destination, 'wx');
  const central = [],
    seen = new Set();
  let offset = 0;
  const write = async (bytes) => {
    let written = 0;
    while (written < bytes.length)
      written += (await output.write(bytes, written, bytes.length - written)).bytesWritten;
    offset += bytes.length;
    fail(offset <= TOTAL_LIMIT, '离线发布归档超过1GiB');
  };
  try {
    for (const member of members) {
      relativePath(member.name);
      fail(!seen.has(member.name), '离线发布成员重复');
      seen.add(member.name);
      const name = Buffer.from(member.name),
        start = offset;
      let crc = 0xffffffff,
        size = 0;
      const chunks = () => (member.bytes ? [member.bytes] : createReadStream(member.path));
      for await (const chunk of chunks()) {
        crc = crcUpdate(crc, chunk);
        size += chunk.length;
        fail(size <= RESOURCE_LIMIT, '单个离线成员超过256MiB');
      }
      crc = (crc ^ 0xffffffff) >>> 0;
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x800, 6);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(size, 18);
      local.writeUInt32LE(size, 22);
      local.writeUInt16LE(name.length, 26);
      await write(local);
      await write(name);
      let secondCrc = 0xffffffff,
        secondSize = 0;
      for await (const chunk of chunks()) {
        secondCrc = crcUpdate(secondCrc, chunk);
        secondSize += chunk.length;
        await write(chunk);
      }
      fail(
        secondSize === size && (secondCrc ^ 0xffffffff) >>> 0 === crc,
        '离线归档源在写入期间发生变化',
      );
      const record = Buffer.alloc(46);
      record.writeUInt32LE(0x02014b50);
      record.writeUInt16LE(0x314, 4);
      record.writeUInt16LE(20, 6);
      record.writeUInt16LE(0x800, 8);
      record.writeUInt32LE(crc, 16);
      record.writeUInt32LE(size, 20);
      record.writeUInt32LE(size, 24);
      record.writeUInt16LE(name.length, 28);
      record.writeUInt32LE(0x81a40000, 38);
      record.writeUInt32LE(start, 42);
      central.push(Buffer.concat([record, name]));
    }
    const start = offset;
    for (const record of central) await write(record);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(offset - start, 12);
    end.writeUInt32LE(start, 16);
    await write(end);
    await output.sync();
  } finally {
    await output.close();
  }
}

export async function writeTgz(destination, members) {
  const chunks = [];
  let size = 0;
  for (const [name, bytes] of members) {
    relativePath(name);
    const header = Buffer.alloc(512),
      encoded = Buffer.from(name);
    if (encoded.length <= 100) encoded.copy(header);
    else {
      const split = name.lastIndexOf('/');
      fail(
        split > 0 &&
          Buffer.byteLength(name.slice(0, split)) <= 155 &&
          Buffer.byteLength(name.slice(split + 1)) <= 100,
        'TAR 路径超过 USTAR 上限',
      );
      header.write(name.slice(0, split), 345);
      header.write(name.slice(split + 1));
    }
    const octal = (value, width) => value.toString(8).padStart(width - 1, '0') + '\0';
    header.write(octal(name.endsWith('.exe') ? 0o755 : 0o644, 8), 100);
    header.write(octal(0, 8), 108);
    header.write(octal(0, 8), 116);
    header.write(octal(bytes.length, 12), 124);
    header.write(octal(0, 12), 136);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write('ustar\0', 257);
    header.write('00', 263);
    header.write(
      header
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, '0') + '\0 ',
      148,
    );
    const padding = Buffer.alloc((512 - (bytes.length % 512)) % 512);
    size += 512 + bytes.length + padding.length;
    fail(size <= RESOURCE_LIMIT, 'TAR 内容超过256MiB');
    chunks.push(header, bytes, padding);
  }
  chunks.push(Buffer.alloc(1024));
  await writeFile(destination, gzipSync(Buffer.concat(chunks)), { flag: 'wx' });
}

async function zipMembers(path) {
  const data = await readFile(path);
  fail(data.length <= RESOURCE_LIMIT && data.length >= 22, 'ZIP 归档大小无效');
  let end = data.length - 22;
  while (end >= Math.max(0, data.length - 65557) && data.readUInt32LE(end) !== 0x06054b50) end--;
  fail(
    end >= 0 &&
      data.readUInt16LE(end + 4) === 0 &&
      data.readUInt16LE(end + 6) === 0 &&
      end + 22 + data.readUInt16LE(end + 20) === data.length,
    'ZIP 尾部或分卷不受支持',
  );
  const count = data.readUInt16LE(end + 10),
    directory = data.readUInt32LE(end + 16);
  fail(
    count > 0 && count <= 16384 && directory + data.readUInt32LE(end + 12) === end,
    'ZIP 目录数量或边界无效',
  );
  const members = new Map();
  let cursor = directory,
    expanded = 0;
  const { inflateRawSync } = await import('node:zlib');
  for (let index = 0; index < count; index++) {
    fail(cursor + 46 <= end && data.readUInt32LE(cursor) === 0x02014b50, 'ZIP 中央目录无效');
    const flags = data.readUInt16LE(cursor + 8),
      method = data.readUInt16LE(cursor + 10),
      packed = data.readUInt32LE(cursor + 20),
      size = data.readUInt32LE(cursor + 24);
    const length = data.readUInt16LE(cursor + 28),
      extra = data.readUInt16LE(cursor + 30),
      comment = data.readUInt16LE(cursor + 32),
      start = data.readUInt32LE(cursor + 42);
    fail(
      cursor + 46 + length + extra + comment <= end && !(flags & 1) && [0, 8].includes(method),
      'ZIP 加密、压缩方式或目录边界无效',
    );
    const name = data.subarray(cursor + 46, cursor + 46 + length).toString('utf8');
    const directoryMember = name.endsWith('/');
    relativePath(directoryMember ? name.slice(0, -1) : name);
    const mode = data.readUInt32LE(cursor + 38) >>> 16;
    fail(
      !mode || (mode & 0xf000) === 0 || (mode & 0xf000) === (directoryMember ? 0x4000 : 0x8000),
      'ZIP 含链接或特殊文件',
    );
    fail(start + 30 <= directory && data.readUInt32LE(start) === 0x04034b50, 'ZIP 本地头无效');
    const localLength = data.readUInt16LE(start + 26),
      localExtra = data.readUInt16LE(start + 28),
      content = start + 30 + localLength + localExtra;
    fail(
      content + packed <= directory &&
        data.subarray(start + 30, start + 30 + localLength).toString('utf8') === name &&
        data.readUInt16LE(start + 8) === method,
      'ZIP 成员名称或数据边界无效',
    );
    expanded += size;
    fail(expanded <= RESOURCE_LIMIT, 'ZIP 展开内容超过256MiB');
    const bytes =
      method === 0
        ? data.subarray(content, content + packed)
        : inflateRawSync(data.subarray(content, content + packed), {
            maxOutputLength: Math.max(size, 1),
          });
    fail(
      bytes.length === size && crc32(bytes) === data.readUInt32LE(cursor + 16),
      'ZIP 成员长度或 CRC 不符',
    );
    if (!directoryMember) {
      fail(!members.has(name), 'ZIP 普通文件重复');
      members.set(name, bytes);
    }
    cursor += 46 + length + extra + comment;
  }
  fail(cursor === end, 'ZIP 中央目录结束位置无效');
  return members;
}

async function tarMembers(path) {
  const gunzip = createGunzip(),
    input = createReadStream(path),
    chunks = [];
  let length = 0;
  input.on('error', (error) => gunzip.destroy(error));
  input.pipe(gunzip);
  try {
    for await (const chunk of gunzip) {
      length += chunk.length;
      fail(length <= RESOURCE_LIMIT, 'TGZ 展开超过256MiB');
      chunks.push(chunk);
    }
  } finally {
    input.destroy();
    gunzip.destroy();
  }
  const data = Buffer.concat(chunks),
    members = new Map();
  let cursor = 0;
  const text = (buffer) => buffer.toString('utf8').split('\0')[0];
  while (cursor + 512 <= data.length) {
    const header = data.subarray(cursor, cursor + 512);
    if (header.every((byte) => byte === 0)) break;
    const expected = parseInt(text(header.subarray(148, 156)).trim(), 8);
    const actual = header.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0,
    );
    fail(expected === actual, 'TAR 校验和无效');
    const prefix = text(header.subarray(345, 500)),
      rawName = text(header.subarray(0, 100));
    const type = header[156],
      directory = type === 53;
    const name = (prefix ? `${prefix}/${rawName}` : rawName).replace(/\/$/, '');
    relativePath(name);
    fail([0, 48, 53].includes(type), 'TAR 含链接、扩展头或特殊文件');
    const sizeText = text(header.subarray(124, 136)).trim();
    fail(/^[0-7]+$/.test(sizeText), 'TAR 长度无效');
    const size = parseInt(sizeText, 8),
      start = cursor + 512;
    fail(start + size <= data.length, 'TAR 成员越界');
    if (!directory) {
      fail(!members.has(name), 'TAR 普通文件重复');
      members.set(name, data.subarray(start, start + size));
    }
    cursor = start + Math.ceil(size / 512) * 512;
    fail(members.size <= 16384, 'TAR 成员过多');
  }
  fail(
    members.size > 0 && data.subarray(cursor).every((byte) => byte === 0),
    'TAR 尾部或普通文件数量无效',
  );
  return members;
}

export async function archiveMembers(path, format) {
  if (format === 'file') return new Map([['payload', await readFile(path)]]);
  if (format === 'zip') return zipMembers(path);
  if (format === 'tgz') return tarMembers(path);
  throw new Error('不支持的发布归档格式');
}

export async function verifyEntries(path, variant) {
  const members = await archiveMembers(path, variant.format);
  for (const entry of Object.values(variant.entries ?? {}))
    fail(members.has(entry), `工具资源入口不存在：${entry}`);
  return members;
}
