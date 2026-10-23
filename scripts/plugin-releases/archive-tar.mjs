// TGZ 按头和正文消费；大工具不会整包解压到内存。
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { createGunzip } from 'node:zlib';
import { relativePath, RESOURCE_LIMIT, EXPANDED_LIMIT, MEMBER_LIMIT } from './contract.mjs';
import { fail, memberCollector } from './archive-common.mjs';

class Reader {
  constructor(stream) {
    this.iterator = stream[Symbol.asyncIterator]();
    this.chunk = Buffer.alloc(0);
    this.offset = 0;
    this.total = 0;
  }
  async consume(length, accept) {
    let remaining = length;
    while (remaining > 0) {
      if (this.offset === this.chunk.length) {
        const next = await this.iterator.next();
        if (next.done) return length - remaining;
        this.chunk = next.value;
        this.offset = 0;
        this.total += this.chunk.length;
        fail(this.total <= EXPANDED_LIMIT + MEMBER_LIMIT * 1024 + 1024 * 1024, 'TGZ 展开结构超过上限');
      }
      const count = Math.min(remaining, this.chunk.length - this.offset);
      accept(this.chunk.subarray(this.offset, this.offset + count));
      remaining -= count;
      this.offset += count;
    }
    return length;
  }
  async block() {
    const bytes = Buffer.alloc(512);
    let offset = 0;
    const count = await this.consume(512, (chunk) => { chunk.copy(bytes, offset); offset += chunk.length; });
    fail(count === 512, 'TAR 头或尾部截断');
    return bytes;
  }
}
const text = (bytes) => bytes.toString('utf8').split('\0')[0];
export async function tarMembers(path, { collect = true } = {}) {
  const stat = await lstat(path);
  fail(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= RESOURCE_LIMIT, 'TGZ 归档大小或类型无效');
  const input = createReadStream(path), gunzip = createGunzip(),
    reader = new Reader(gunzip), collector = memberCollector(collect), names = new Set();
  input.on('error', (error) => gunzip.destroy(error));
  input.pipe(gunzip);
  let expanded = 0, count = 0;
  try {
    while (true) {
      const header = await reader.block();
      if (header.every((byte) => byte === 0)) {
        fail((await reader.block()).every((byte) => byte === 0), 'TAR 结束标记无效');
        let trailing = 0;
        while (await reader.consume(65536, (chunk) => {
          trailing += chunk.length;
          fail(trailing <= 1024 * 1024 && chunk.every((byte) => byte === 0), 'TAR 尾部无效');
        })) { /* 消费 gzip 尾部，使压缩层校验也完成。 */ }
        break;
      }
      const expected = parseInt(text(header.subarray(148, 156)).trim(), 8),
        actual = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
      fail(expected === actual, 'TAR 校验和无效');
      const prefix = text(header.subarray(345, 500)), rawName = text(header.subarray(0, 100)),
        type = header[156], directory = type === 53,
        name = (prefix ? `${prefix}/${rawName}` : rawName).replace(/\/$/, '');
      relativePath(name);
      fail([0, 48, 53].includes(type), 'TAR 含链接、扩展头或特殊文件');
      fail(!names.has(name) && ++count <= MEMBER_LIMIT, 'TAR 成员重复或过多');
      names.add(name);
      const sizeText = text(header.subarray(124, 136)).trim();
      fail(/^[0-7]+$/.test(sizeText), 'TAR 长度无效');
      const size = parseInt(sizeText, 8);
      expanded += size;
      fail(size <= RESOURCE_LIMIT && expanded <= EXPANDED_LIMIT && (!directory || size === 0), 'TAR 展开超过上限或目录含正文');
      if (!directory) collector.check(size);
      const chunks = [];
      fail(await reader.consume(size, (chunk) => { if (collect && !directory) chunks.push(chunk); }) === size, 'TAR 成员截断');
      const padding = (512 - size % 512) % 512;
      fail(await reader.consume(padding, (chunk) => fail(chunk.every((byte) => byte === 0), 'TAR 填充无效')) === padding, 'TAR 填充截断');
      if (!directory) collector.add(name, size, chunks);
    }
    fail(collector.members.size > 0, 'TAR 没有普通文件');
    return collector.members;
  } finally { input.destroy(); gunzip.destroy(); }
}
