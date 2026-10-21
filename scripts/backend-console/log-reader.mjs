import { open, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';

export const CHUNK_BYTES = 64 * 1024;
export const LINE_BYTES = 256 * 1024;
export const POLL_BYTES = 256 * 1024;
const MAX_FILES = 512;
const decoder = new TextDecoder('utf-8', { fatal: true });
export const INVALID_LINE = '日志记录损坏，已略过该行。';
export const OVERSIZED_LINE = '日志单行超过 256 KiB，已略过该行并继续读取。';

export function checkLimit(limit) {
  if (!Number.isInteger(limit) || limit < 0 || limit > 1000)
    throw new Error('最近日志条数必须为 0–1000 的整数');
}

export const identity = (info) => `${info.dev}:${info.ino}:${info.birthtimeMs}`;

export async function snapshots(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    // 后端首次建立日志目录前允许空快照；其他存储错误必须交给调用方处理。
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const names = entries
    .filter((entry) => /^deviceforge(?:\..+)?\.jsonl$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (names.length > MAX_FILES) throw new Error('日志文件数量超过 512，无法继续有界跟随');
  const files = [];
  for (const name of names) {
    const path = join(directory, name);
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error('日志命名空间中存在非普通文件或符号链接');
    files.push({ name, path, size: info.size, identity: identity(info) });
  }
  return files;
}

export async function withFile(file, run) {
  let handle;
  try {
    handle = await open(file.path, 'r');
  } catch (error) {
    // 发现目录与打开文件之间，滚动保留策略可能已经移除了这个文件。
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || identity(info) !== file.identity)
      throw new Error('日志文件在打开期间发生变化，请在下一轮重新读取');
    return await run(handle, info);
  } finally {
    await handle.close();
  }
}

export function parseLine(bytes) {
  if (!bytes.length || (bytes.length === 1 && bytes[0] === 13)) return {};
  try {
    const record = JSON.parse(decoder.decode(bytes).replace(/^\uFEFF/, ''));
    if (!record || typeof record !== 'object' || Array.isArray(record))
      return { notice: INVALID_LINE };
    return { record };
  } catch {
    return { notice: INVALID_LINE };
  }
}

// 完整一行才解码 UTF-8；中文字符即使跨文件块或两次轮询也不会被替换。
export function consume(state, bytes, emit) {
  let start = 0;
  while (start < bytes.length) {
    const newline = bytes.indexOf(10, start);
    const end = newline === -1 ? bytes.length : newline;
    const segment = bytes.subarray(start, end);
    if (!state.dropping) {
      if (state.pending.length + segment.length > LINE_BYTES) {
        state.pending = Buffer.alloc(0);
        state.dropping = true;
        emit({ notice: OVERSIZED_LINE });
      } else if (segment.length) {
        state.pending = Buffer.concat([state.pending, segment]);
      }
    }
    if (newline === -1) break;
    if (!state.dropping) emit(parseLine(state.pending));
    state.pending = Buffer.alloc(0);
    state.dropping = false;
    start = newline + 1;
  }
}

export async function trailingState(handle, size) {
  const length = Math.min(size, LINE_BYTES + 1);
  const bytes = Buffer.alloc(length);
  const { bytesRead } = await handle.read(bytes, 0, length, size - length);
  if (bytesRead !== length) throw new Error('日志文件在读取尾部期间被截断，请重新读取');
  const suffix = bytes.subarray(0, bytesRead);
  const start = suffix.lastIndexOf(10) + 1;
  const pending = suffix.subarray(start);
  return {
    offset: size,
    pending: pending.length > LINE_BYTES ? Buffer.alloc(0) : Buffer.from(pending),
    dropping: pending.length > LINE_BYTES,
    checkpoint: Buffer.from(suffix.subarray(Math.max(0, suffix.length - 64))),
  };
}

async function* reverseLines(handle, size) {
  let position = size;
  let pending = Buffer.alloc(0);
  let dropping = false;
  let skipIncomplete = true;
  const buffer = Buffer.alloc(CHUNK_BYTES);
  while (position > 0) {
    const length = Math.min(position, buffer.length);
    position -= length;
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead !== length) throw new Error('日志文件在倒读期间被截断，请重新读取');
    let end = length;
    for (let index = length - 1; index >= 0; index--) {
      if (buffer[index] !== 10) continue;
      const segment = buffer.subarray(index + 1, end);
      if (pending.length + segment.length > LINE_BYTES) dropping = true;
      const line = dropping ? null : Buffer.concat([segment, pending]);
      if (skipIncomplete) skipIncomplete = false;
      else yield dropping ? { notice: OVERSIZED_LINE } : parseLine(line);
      pending = Buffer.alloc(0);
      dropping = false;
      end = index;
    }
    if (!dropping && pending.length + end > LINE_BYTES) {
      dropping = true;
      pending = Buffer.alloc(0);
    }
    if (!dropping && end) pending = Buffer.concat([buffer.subarray(0, end), pending]);
  }
  if (!skipIncomplete) yield dropping ? { notice: OVERSIZED_LINE } : parseLine(pending);
}

export async function recent(files, limit, notify = () => {}) {
  const records = [];
  if (!limit) return records;
  for (let index = files.length - 1; index >= 0 && records.length < limit; index--) {
    await withFile(files[index], async (handle) => {
      for await (const item of reverseLines(handle, files[index].size)) {
        if (item.notice) notify(item.notice);
        if (item.record) records.push(item.record);
        if (records.length === limit) break;
      }
    });
  }
  // 宿主按日期滚动；并发记录的时间戳可能略有交错，展示时按事件时间稳定排序。
  records.reverse();
  records.sort((left, right) => {
    const first = typeof left.timestamp === 'string' ? Date.parse(left.timestamp) : NaN;
    const second = typeof right.timestamp === 'string' ? Date.parse(right.timestamp) : NaN;
    return Number.isFinite(first) && Number.isFinite(second) ? first - second : 0;
  });
  return records;
}

export async function checkpointMatches(handle, state) {
  if (!state.checkpoint.length) return true;
  const bytes = Buffer.alloc(state.checkpoint.length);
  const { bytesRead } = await handle.read(bytes, 0, bytes.length, state.offset - bytes.length);
  return bytesRead === bytes.length && bytes.equals(state.checkpoint);
}

export async function advance(handle, size, state, emit) {
  const end = Math.min(size, state.offset + POLL_BYTES);
  const buffer = Buffer.alloc(CHUNK_BYTES);
  while (state.offset < end) {
    const length = Math.min(buffer.length, end - state.offset);
    const { bytesRead } = await handle.read(buffer, 0, length, state.offset);
    if (!bytesRead) break;
    const bytes = buffer.subarray(0, bytesRead);
    consume(state, bytes, emit);
    state.offset += bytesRead;
    state.checkpoint = Buffer.from(Buffer.concat([state.checkpoint, bytes]).subarray(-64));
  }
}
