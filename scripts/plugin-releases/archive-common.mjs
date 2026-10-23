// ZIP/TAR 共用的有界规则；只持有校验状态，不积累工具正文。
import { crc32 } from 'node:zlib';
export const fail = (condition, message) => {
  if (!condition) throw new Error(message);
};
export function crcUpdate(crc, data) {
  return (crc32(data, (crc ^ 0xffffffff) >>> 0) ^ 0xffffffff) >>> 0;
}
// 只有插件描述与模板改写需要正文；大工具仅校验名字、长度和校验和。
export const BUFFER_LIMIT = 256 * 1024 * 1024;
export function memberCollector(collect) {
  const members = new Map();
  let buffered = 0;
  return {
    members,
    add(name, size, chunks) {
      fail(!members.has(name), '归档普通文件重复');
      if (collect) {
        buffered += size;
        fail(buffered <= BUFFER_LIMIT, '需要读取正文的组件内容超过256MiB');
      }
      members.set(name, collect ? Buffer.concat(chunks, size) : { size });
    },
    check(size) {
      if (collect) fail(buffered + size <= BUFFER_LIMIT, '需要读取正文的组件内容超过256MiB');
    },
  };
}
export async function readAt(file, position, length) {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const read = await file.read(bytes, offset, length - offset, position + offset);
    fail(read.bytesRead > 0, '归档读取截断');
    offset += read.bytesRead;
  }
  return bytes;
}
