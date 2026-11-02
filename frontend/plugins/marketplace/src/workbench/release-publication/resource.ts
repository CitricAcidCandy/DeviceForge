import { sha256 } from '@noble/hashes/sha2.js';
import type { ReleaseArchiveEntry } from '../local-import/release-archive.ts';

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; ++bit) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
export function digestBytes(bytes: Uint8Array): string {
  return [...sha256(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
}
async function read(file: Blob, start: number, end: number, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted();
  if (start < 0 || end > file.size || end < start) throw new Error('完整 ZIP 本地文件头被截断');
  const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer());
  signal.throwIfAborted();
  return bytes;
}

export async function resourceSlice(file: File, entry: ReleaseArchiveEntry, dataEnd: number, signal: AbortSignal) {
  const bytes = await read(file, entry.offset, entry.offset + 30, signal);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = view.getUint16(6, true);
  if (view.getUint32(0, true) !== 0x04034b50 || (flags & 1) || view.getUint16(8, true) !== entry.method)
    throw new Error(`ZIP 本地文件头不一致：${entry.name}`);
  if (!(flags & 8) && (view.getUint32(14, true) !== entry.crc || view.getUint32(18, true) !== entry.compressed ||
      view.getUint32(22, true) !== entry.size)) throw new Error(`ZIP 本地大小或 CRC 与目录不一致：${entry.name}`);
  const nameLength = view.getUint16(26, true), extraLength = view.getUint16(28, true);
  const name = new TextDecoder('utf-8', { fatal: true }).decode(await read(file, entry.offset + 30, entry.offset + 30 + nameLength, signal));
  if (name !== entry.name) throw new Error(`ZIP 本地路径与目录不一致：${entry.name}`);
  const start = entry.offset + 30 + nameLength + extraLength, end = start + entry.compressed;
  if (end > dataEnd || (entry.method === 0 && entry.compressed !== entry.size))
    throw new Error(`ZIP 资源大小无效：${entry.name}`);
  return { blob: file.slice(start, end), start: entry.offset, end };
}

// 原样资源直接保留文件切片；压缩资源通过原生流和 Blob 存储承接，JS 不保留整份展开数组。
export async function verifyResource(blob: Blob, entry: ReleaseArchiveEntry, digest: string, signal: AbortSignal): Promise<Blob> {
  signal.throwIfAborted();
  const hash = sha256.create();
  let size = 0, crc = 0xffffffff, yielded = 0;
  async function accept(bytes: Uint8Array) {
    signal.throwIfAborted();
    size += bytes.byteLength;
    if (size > entry.size) throw new Error(`ZIP 资源展开超过声明大小：${entry.name}`);
    hash.update(bytes);
    for (const byte of bytes) crc = (crc >>> 8) ^ (crcTable[(crc ^ byte) & 255] ?? 0);
    yielded += bytes.byteLength;
    if (yielded >= 4 * 1024 * 1024) {
      yielded = 0;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      signal.throwIfAborted();
    }
  }
  function finish() {
    signal.throwIfAborted();
    if (size !== entry.size || ((crc ^ 0xffffffff) >>> 0) !== entry.crc)
      throw new Error(`ZIP 资源大小或 CRC 不一致：${entry.name}`);
    if ([...hash.digest()].map((value) => value.toString(16).padStart(2, '0')).join('') !== digest)
      throw new Error(`发布资源 SHA-256 不一致：${entry.name}`);
  }
  try {
    if (entry.method === 0) {
      await blob.stream().pipeTo(new WritableStream<Uint8Array>({ write: accept, close: finish }), { signal });
      return blob;
    }
    let decompressor: DecompressionStream;
    try { decompressor = new DecompressionStream('deflate-raw'); }
    catch { throw new Error('当前浏览器不支持流式展开，请使用新版浏览器或发布器生成的未压缩完整 ZIP'); }
    const checked = blob.stream().pipeThrough(decompressor, { signal }).pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        async transform(bytes, controller) { await accept(bytes); controller.enqueue(bytes); },
        flush: finish,
      }), { signal },
    );
    return await new Response(checked).blob();
  } finally {
    hash.destroy();
  }
}
