import {
  createFileBrowser, metadataFromWire, entriesFromWire, metadataToWire, entriesToWire,
} from '@deviceforge/files/model';
import type { ArtifactBrowserSnapshot as PublicSnapshot } from '@deviceforge/files/model';
import { ApiError } from '../../../services/api/index.ts';
import type { ApiResult, ArchiveEntryQuery } from '../../../services/api/index.ts';
import type {
  ArtifactBrowserGateway, ArtifactBrowserSnapshot,
} from '../types/index.ts';
export type * from '../types/index.ts';

/** 旧入口仅适配旧字段与错误类，业务状态和取消规则由独立文件插件唯一实现。 */
export function createArtifactBrowser(gateway: ArtifactBrowserGateway) {
  const { upload, download } = gateway;
  const browser = createFileBrowser({
    metadata: (id, signal) => mapped(gateway.metadata(id, signal), metadataFromWire),
    entries: (id, query, signal) => mapped(gateway.entries(id, query, signal), entriesFromWire),
    remove: (id, signal) => mapped(gateway.remove(id, signal), metadataFromWire),
    ...(upload ? {
      upload: (filename: string, content: Blob, signal: AbortSignal) =>
        mapped(upload(filename, content, signal), metadataFromWire),
    } : {}),
    ...(download ? { download } : {}),
  }, ApiError);
  let previous: PublicSnapshot | null = null;
  let cached: ArtifactBrowserSnapshot | null = null;
  function snapshot(): ArtifactBrowserSnapshot {
    const current = browser.snapshot();
    if (current === previous && cached) return cached;
    previous = current;
    cached = Object.freeze({
      ...current,
      metadata: current.metadata ? metadataToWire(current.metadata) : null,
      page: current.page ? entriesToWire(current.page) : null,
    });
    return cached;
  }
  return {
    select: (id: string, signal: AbortSignal) =>
      mapped(browser.select(id, signal), metadataToWire),
    page: (query: ArchiveEntryQuery, signal: AbortSignal) =>
      mapped(browser.page(query, signal), entriesToWire),
    remove: (id: string, signal: AbortSignal) =>
      mapped(browser.remove(id, signal), metadataToWire),
    upload: (filename: string, content: Blob, signal: AbortSignal) =>
      mapped(browser.upload(filename, content, signal), metadataToWire),
    download: browser.download,
    snapshot,
    subscribe: (listener: (value: ArtifactBrowserSnapshot) => void) =>
      browser.subscribe(() => listener(snapshot())),
    clear: browser.clear,
    dispose: browser.dispose,
    publicModel: browser,
  };
}
async function mapped<T, V>(
  request: Promise<ApiResult<T>>, map: (value: T) => V,
): Promise<ApiResult<V>> {
  const result = await request;
  return { data: map(result.data), logId: result.logId };
}