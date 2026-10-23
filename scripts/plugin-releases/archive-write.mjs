// 发布归档写入独占新文件；ZIP 两遍读取源并核对 CRC，TGZ 按成员流式压缩。
import { open } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { relativePath, RESOURCE_LIMIT, OFFLINE_LIMIT, EXPANDED_LIMIT, MEMBER_LIMIT } from './contract.mjs';
import { crcUpdate, fail } from './archive-common.mjs';

export async function writeZip(destination, members) {
  fail(members.length > 0 && members.length <= MEMBER_LIMIT, '离线资源成员数量无效');
  const output = await open(destination, 'wx'), central = [], seen = new Set();
  let offset = 0;
  const write = async (bytes) => {
    fail(offset + bytes.length <= OFFLINE_LIMIT, '离线发布归档超过4GiB');
    let written = 0;
    while (written < bytes.length) written += (await output.write(bytes, written, bytes.length - written)).bytesWritten;
    offset += bytes.length;
  };
  try {
    for (const member of members) {
      relativePath(member.name);
      fail(!seen.has(member.name), '离线发布成员重复');
      seen.add(member.name);
      const name = Buffer.from(member.name), start = offset;
      let crc = 0xffffffff, size = 0;
      const chunks = () => (member.bytes ? [member.bytes] : createReadStream(member.path));
      for await (const chunk of chunks()) { crc = crcUpdate(crc, chunk); size += chunk.length; fail(size <= RESOURCE_LIMIT, '单个离线成员超过2GiB'); }
      crc = (crc ^ 0xffffffff) >>> 0;
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
      local.writeUInt32LE(crc, 14); local.writeUInt32LE(size, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26);
      await write(local); await write(name);
      let secondCrc = 0xffffffff, secondSize = 0;
      for await (const chunk of chunks()) { secondCrc = crcUpdate(secondCrc, chunk); secondSize += chunk.length; await write(chunk); }
      fail(secondSize === size && (secondCrc ^ 0xffffffff) >>> 0 === crc, '离线归档源在写入期间发生变化');
      const record = Buffer.alloc(46);
      record.writeUInt32LE(0x02014b50); record.writeUInt16LE(0x314, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8);
      record.writeUInt32LE(crc, 16); record.writeUInt32LE(size, 20); record.writeUInt32LE(size, 24); record.writeUInt16LE(name.length, 28);
      record.writeUInt32LE(0x81a40000, 38); record.writeUInt32LE(start, 42);
      central.push(Buffer.concat([record, name]));
    }
    const start = offset;
    for (const record of central) await write(record);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(offset - start, 12); end.writeUInt32LE(start, 16);
    await write(end); await output.sync();
  } finally { await output.close(); }
}

function tarHeader(name, size) {
  relativePath(name);
  const header = Buffer.alloc(512), encoded = Buffer.from(name);
  if (encoded.length <= 100) encoded.copy(header);
  else {
    const split = name.lastIndexOf('/');
    fail(split > 0 && Buffer.byteLength(name.slice(0, split)) <= 155 && Buffer.byteLength(name.slice(split + 1)) <= 100, 'TAR 路径超过 USTAR 上限');
    header.write(name.slice(0, split), 345); header.write(name.slice(split + 1));
  }
  const octal = (value, width) => value.toString(8).padStart(width - 1, '0') + '\0';
  header.write(octal(name.endsWith('.exe') ? 0o755 : 0o644, 8), 100); header.write(octal(0, 8), 108); header.write(octal(0, 8), 116);
  header.write(octal(size, 12), 124); header.write(octal(0, 12), 136); header.fill(32, 148, 156); header[156] = 48;
  header.write('ustar\0', 257); header.write('00', 263);
  header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
  return header;
}
export async function writeTgz(destination, members) {
  fail(members.size > 0 && members.size <= MEMBER_LIMIT, 'TAR 成员数量无效');
  async function* chunks() {
    let expanded = 0;
    for (const [name, bytes] of members) {
      expanded += bytes.length;
      fail(bytes.length <= RESOURCE_LIMIT && expanded <= EXPANDED_LIMIT, 'TAR 内容超过上限');
      yield tarHeader(name, bytes.length); yield bytes;
      yield Buffer.alloc((512 - bytes.length % 512) % 512);
    }
    yield Buffer.alloc(1024);
  }
  await pipeline(Readable.from(chunks()), createGzip(), createWriteStream(destination, { flags: 'wx' }));
}
