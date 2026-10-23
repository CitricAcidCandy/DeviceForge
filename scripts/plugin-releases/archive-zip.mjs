// 按中央目录逐个流式核验 ZIP；ZIP64、多卷、链接和重叠正文均拒绝。
import { lstat, open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInflateRaw } from 'node:zlib';
import { relativePath, RESOURCE_LIMIT, OFFLINE_LIMIT, EXPANDED_LIMIT, MEMBER_LIMIT } from './contract.mjs';
import { fail, readAt, crcUpdate, memberCollector } from './archive-common.mjs';

export async function zipMembers(path, { collect = true, limit = OFFLINE_LIMIT } = {}) {
  const inputStat = await lstat(path);
  fail(inputStat.isFile() && !inputStat.isSymbolicLink(), 'ZIP 归档类型无效');
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    fail(stat.isFile() && stat.size >= 22 && stat.size <= limit, 'ZIP 归档大小无效');
    const tailStart = Math.max(0, stat.size - 65557),
      tail = await readAt(file, tailStart, stat.size - tailStart);
    let end = tail.length - 22;
    while (end >= 0 && tail.readUInt32LE(end) !== 0x06054b50) end--;
    fail(
      end >= 0 && tail.readUInt16LE(end + 4) === 0 && tail.readUInt16LE(end + 6) === 0 &&
        end + 22 + tail.readUInt16LE(end + 20) === tail.length,
      'ZIP 尾部或分卷不受支持',
    );
    const count = tail.readUInt16LE(end + 10),
      directory = tail.readUInt32LE(end + 16),
      boundary = tailStart + end;
    fail(count > 0 && count <= MEMBER_LIMIT && count === tail.readUInt16LE(end + 8) &&
      directory + tail.readUInt32LE(end + 12) === boundary, 'ZIP 目录数量或边界无效');
    const collector = memberCollector(collect), ranges = [], names = new Set();
    let cursor = directory, expanded = 0;
    for (let index = 0; index < count; index++) {
      fail(cursor + 46 <= boundary, 'ZIP 中央目录截断');
      const header = await readAt(file, cursor, 46);
      fail(header.readUInt32LE(0) === 0x02014b50, 'ZIP 中央目录无效');
      const flags = header.readUInt16LE(8), method = header.readUInt16LE(10),
        packed = header.readUInt32LE(20), size = header.readUInt32LE(24),
        length = header.readUInt16LE(28), extra = header.readUInt16LE(30),
        comment = header.readUInt16LE(32), start = header.readUInt32LE(42);
      fail(cursor + 46 + length + extra + comment <= boundary && !(flags & ~(method === 8 ? 0x080e : 0x0808)) &&
        [0, 8].includes(method) && size <= RESOURCE_LIMIT && packed !== 0xffffffff &&
        start !== 0xffffffff && header.readUInt16LE(34) === 0 &&
        (method === 0 ? packed === size : packed > 0),
      'ZIP 加密、压缩方式、ZIP64 或目录边界无效');
      const nameBytes = await readAt(file, cursor + 46, length), name = nameBytes.toString('utf8'),
        directoryMember = name.endsWith('/');
      fail(Buffer.from(name).equals(nameBytes), 'ZIP 成员名称不是有效 UTF-8');
      relativePath(directoryMember ? name.slice(0, -1) : name);
      fail(!names.has(name), 'ZIP 成员名称重复');
      names.add(name);
      const mode = header.readUInt32LE(38) >>> 16;
      fail(!mode || (mode & 0xf000) === 0 || (mode & 0xf000) === (directoryMember ? 0x4000 : 0x8000), 'ZIP 含链接或特殊文件');
      fail(start + 30 <= directory, 'ZIP 本地头越界');
      const local = await readAt(file, start, 30),
        localLength = local.readUInt16LE(26), localExtra = local.readUInt16LE(28),
        content = start + 30 + localLength + localExtra;
      fail(local.readUInt32LE(0) === 0x04034b50 && local.readUInt16LE(6) === flags &&
        local.readUInt16LE(8) === method && content + packed <= directory &&
        (await readAt(file, start + 30, localLength)).toString('utf8') === name,
      'ZIP 成员名称或数据边界无效');
      if (!(flags & 8)) fail(local.readUInt32LE(14) === header.readUInt32LE(16) &&
        local.readUInt32LE(18) === packed && local.readUInt32LE(22) === size, 'ZIP 本地头与目录不一致');
      let memberEnd = content + packed;
      if (flags & 8) {
        fail(memberEnd + 12 <= directory, 'ZIP 数据描述符截断');
        const marker = await readAt(file, memberEnd, 4), signed = marker.readUInt32LE(0) === 0x08074b50;
        fail(memberEnd + (signed ? 16 : 12) <= directory, 'ZIP 数据描述符越界');
        const descriptor = await readAt(file, memberEnd + (signed ? 4 : 0), 12);
        fail(descriptor.readUInt32LE(0) === header.readUInt32LE(16) &&
          descriptor.readUInt32LE(4) === packed && descriptor.readUInt32LE(8) === size,
        'ZIP 数据描述符与目录不一致');
        memberEnd += signed ? 16 : 12;
      }
      expanded += size;
      fail(expanded <= EXPANDED_LIMIT && (!directoryMember || size === 0), 'ZIP 展开超过8GiB或目录含正文');
      ranges.push([start, memberEnd]);
      if (!directoryMember) collector.check(size);
      const input = packed ? createReadStream(path, { start: content, end: content + packed - 1 }) : null,
        inflate = method === 8 ? createInflateRaw() : null;
      let bytes = 0, crc = 0xffffffff;
      const chunks = [];
      if (input && inflate) { input.on('error', (error) => inflate.destroy(error)); input.pipe(inflate); }
      try {
        for await (const chunk of (inflate && input ? inflate : input) ?? []) {
          bytes += chunk.length;
          fail(bytes <= size, 'ZIP 成员展开超过声明长度');
          crc = crcUpdate(crc, chunk);
          if (collect && !directoryMember) chunks.push(chunk);
        }
        fail(bytes === size && ((crc ^ 0xffffffff) >>> 0) === header.readUInt32LE(16) &&
          (!inflate || !input || inflate.bytesWritten === packed), 'ZIP 成员长度或 CRC 不符');
      } finally { input?.destroy(); inflate?.destroy(); }
      if (!directoryMember) collector.add(name, size, chunks);
      cursor += 46 + length + extra + comment;
    }
    ranges.sort((a, b) => a[0] - b[0]);
    for (let index = 1; index < ranges.length; index++) fail(ranges[index - 1][1] <= ranges[index][0], 'ZIP 成员数据重叠');
    fail(cursor === boundary && collector.members.size > 0, 'ZIP 中央目录结束位置或普通文件数量无效');
    return collector.members;
  } finally { await file.close(); }
}
