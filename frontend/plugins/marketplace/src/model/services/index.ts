import type {
  MarketplacePublishEntry,
  MarketplaceQuery,
  MarketplaceResourceRecord,
  MarketplaceDownloadedResource,
  MarketplaceSnapshot,
  MarketplaceUploadFile,
  MarketplaceKind,
} from '../types/index.ts';
import { readVerifiedResource } from './download.ts';
import { decodeCatalog } from './catalog.ts';
import { readReleaseCapabilities, probePublicationResource } from './publication.ts';
import { marketplaceJson, marketplaceRequest, requireMarketplaceOk } from './transport.ts';

export const DEFAULT_MARKETPLACE_URL = 'http://127.0.0.1:7040';
const STORAGE_KEY = 'deviceforge.marketplace.url';
export type MarketplaceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function normalizeUrl(value: string): string {
  const url = new URL(value.trim());
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('市场地址必须为不含凭证、查询参数或片段的 HTTP 地址');
  return url.toString().replace(/\/$/, '');
}

function defaultStorage(): MarketplaceStorage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; }
  catch { return null; }
}
function readOverride(storage: MarketplaceStorage | null): string | null {
  let value: string | null;
  try { value = storage?.getItem(STORAGE_KEY) ?? null; }
  catch { return null; }
  if (!value) return null;
  try {
    return normalizeUrl(value);
  } catch {
    return null;
  }
}

function queryString(query: MarketplaceQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  return params.toString();
}

function decodeResource(value: unknown): MarketplaceResourceRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('资源上传响应无效');
  if (
    !('id' in value) || typeof value.id !== 'string' || !/^[a-f0-9]{64}$/i.test(value.id) ||
    !('sha256' in value) || typeof value.sha256 !== 'string' || value.sha256.toLowerCase() !== value.id.toLowerCase() ||
    !('filename' in value) || typeof value.filename !== 'string' ||
    !('media_type' in value) || typeof value.media_type !== 'string' ||
    !('kind' in value) || typeof value.kind !== 'string' ||
    !('size' in value) || typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 0 ||
    !('created_at' in value) || typeof value.created_at !== 'number' || !Number.isFinite(value.created_at)
  )
    throw new Error('资源上传响应字段缺失');
  return {
    id: value.id, sha256: value.sha256, filename: value.filename,
    media_type: value.media_type, kind: value.kind, size: value.size, created_at: value.created_at,
  };
}

export function createMarketplace(fetcher: typeof fetch = fetch, options: { storage?: MarketplaceStorage | null } = {}) {
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  let override = readOverride(storage);
  const listeners = new Set<(url: string) => void>();
  function url(): string {
    return override ?? DEFAULT_MARKETPLACE_URL;
  }
  function changed() {
    for (const listener of [...listeners]) {
      try { listener(url()); } catch { /* 单个观察者不影响地址保存。 */ }
    }
  }
  return {
    defaultUrl: DEFAULT_MARKETPLACE_URL,
    currentUrl: () => url(),
    setUrl(value: string): string {
      const normalized = normalizeUrl(value);
      storage?.setItem(STORAGE_KEY, normalized);
      override = normalized;
      changed();
      return normalized;
    },
    resetUrl(): string {
      storage?.removeItem(STORAGE_KEY);
      override = null; changed();
      return DEFAULT_MARKETPLACE_URL;
    },
    subscribe(listener: (value: string) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() { listeners.clear(); },
    releaseCapabilities(signal: AbortSignal, source: string = url()) {
      return readReleaseCapabilities(fetcher, normalizeUrl(source), signal);
    },
    probeResource(digest: string, size: number, signal: AbortSignal, source: string = url()) {
      return probePublicationResource(fetcher, normalizeUrl(source), digest, size, signal);
    },
    async search(query: MarketplaceQuery, signal: AbortSignal): Promise<MarketplaceSnapshot> {
      const source = url();
      const response = await marketplaceRequest(
        fetcher,
        `${source}/api/v1/catalog?${queryString(query)}`,
        {
          signal,
          headers: { accept: 'application/json' },
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
        },
        signal,
      );
      await requireMarketplaceOk(response, signal, '市场目录请求');
      return decodeCatalog(await marketplaceJson(response, signal), source);
    },
    async upload(
      file: MarketplaceUploadFile,
      kind: MarketplaceKind,
      signal: AbortSignal,
      source: string = url(),
    ): Promise<MarketplaceResourceRecord> {
      const response = await marketplaceRequest(
        fetcher,
        `${normalizeUrl(source)}/api/v1/resources`,
        {
          method: 'POST',
          signal,
          headers: {
            accept: 'application/json',
            'content-type': file.type || 'application/octet-stream',
            'x-resource-filename': encodeURIComponent(file.name || 'resource.bin'),
            'x-resource-filename-encoding': 'percent',
            'x-resource-kind': kind,
          },
          body: file,
          credentials: 'omit',
          redirect: 'error',
        },
        signal,
      );
      await requireMarketplaceOk(response, signal, '资源上传');
      return decodeResource(await marketplaceJson(response, signal));
    },
    async publish(
      entry: MarketplacePublishEntry,
      signal: AbortSignal,
      source: string = url(),
    ): Promise<MarketplacePublishEntry> {
      const response = await marketplaceRequest(
        fetcher,
        `${normalizeUrl(source)}/api/v1/catalog`,
        {
          method: 'POST',
          signal,
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
          },
          body: JSON.stringify(entry),
          credentials: 'omit',
          redirect: 'error',
        },
        signal,
      );
      await requireMarketplaceOk(response, signal, '市场条目发布');
      const value = await marketplaceJson(response, signal);
      const decoded = decodeCatalog({ entries: [value], total: 1, offset: 0, limit: 1 }, normalizeUrl(source), true).entries[0];
      if (!decoded || decoded.metadataIssues?.length || decoded.id !== entry.id ||
          decoded.version !== entry.version || decoded.kind !== entry.kind)
        throw new Error('市场条目发布响应字段或身份不一致，请查询服务器目录，不要自动重发');
      const { source: _source, sourceName: _sourceName, metadataIssues: _issues, ...published } = decoded;
      return published;
    },
    async download(
      resourceId: string,
      signal: AbortSignal,
      source: string = url(),
    ): Promise<MarketplaceDownloadedResource> {
      if (!/^[a-f0-9]{64}$/i.test(resourceId)) throw new Error('资源摘要无效');
      const response = await marketplaceRequest(
        fetcher,
        `${normalizeUrl(source)}/api/v1/resources/${encodeURIComponent(resourceId)}`,
        {
          signal,
          headers: { accept: '*/*' },
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
        },
        signal,
      );
      await requireMarketplaceOk(response, signal, '资源下载');
      return readVerifiedResource(response, resourceId, signal);
    },
  };
}

export type MarketplaceController = ReturnType<typeof createMarketplace>;
