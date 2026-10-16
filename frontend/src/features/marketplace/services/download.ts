import { sha256 } from '@noble/hashes/sha2.js';
import type { MarketplaceDownloadedResource } from '../types/index.ts';

// 浏览器安装暂存有界，资源服务器本身仍可通过 Range 提供任意大小资源。
export const MAX_MARKETPLACE_DOWNLOAD_BYTES = 256 * 1024 * 1024;

export async function readVerifiedResource(
  response: Response, digest: string, signal: AbortSignal,
): Promise<MarketplaceDownloadedResource> {
  const declared = Number(response.headers.get('content-length'));
  if (declared > MAX_MARKETPLACE_DOWNLOAD_BYTES) {
    await response.body?.cancel();
    throw new Error('文件超过浏览器暂存上限（256 MiB），请使用资源服务下载地址');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('资源响应缺少文件内容');
  const hash = sha256.create();
  const chunks: ArrayBuffer[] = [];
  let size = 0;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_MARKETPLACE_DOWNLOAD_BYTES) throw new Error('文件超过浏览器暂存上限（256 MiB）');
      hash.update(chunk.value);
      chunks.push(new Uint8Array(chunk.value).buffer);
    }
    const actual = Array.from(hash.digest(), (value) => value.toString(16).padStart(2, '0')).join('');
    if (actual !== digest.toLowerCase()) throw new Error('资源 SHA-256 不匹配，已停止下载与安装');
    const mediaType = response.headers.get('content-type') || 'application/octet-stream';
    return {
      blob: new Blob(chunks, { type: mediaType }), size, mediaType,
      filename: (response.headers.get('x-resource-filename') || 'deviceforge-resource.bin').replace(/[\\/\x00-\x1f]/g, '_'),
    };
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
    hash.destroy();
  }
}
