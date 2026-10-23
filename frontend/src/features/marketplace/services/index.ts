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

function readOverride(): string | null {
  if (typeof window === 'undefined') return null;
  const value = window.localStorage.getItem(STORAGE_KEY);
  if (!value) return null;
  try {
    return normalizeUrl(value);
  } catch {
    window.localStorage.removeItem(STORAGE_KEY);
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
  if (!value || typeof value !== 'object') throw new Error('资源上传响应无效');
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== 'string' ||
    typeof record.sha256 !== 'string' ||
    typeof record.filename !== 'string' ||
    typeof record.media_type !== 'string' ||
    typeof record.kind !== 'string' ||
    typeof record.size !== 'number'
  )
    throw new Error('资源上传响应字段缺失');
  return record as unknown as MarketplaceResourceRecord;
}

export function createMarketplace(fetcher: typeof fetch = fetch) {
  let override = readOverride();
  function url(): string {
    return override ?? DEFAULT_MARKETPLACE_URL;
  }
  return {
    defaultUrl: DEFAULT_MARKETPLACE_URL,
    currentUrl: () => url(),
    setUrl(value: string): string {
      const normalized = normalizeUrl(value);
      override = normalized;
      if (typeof window !== 'undefined') window.localStorage.setItem(STORAGE_KEY, normalized);
      return normalized;
    },
    resetUrl(): string {
      override = null;
      if (typeof window !== 'undefined') window.localStorage.removeItem(STORAGE_KEY);
      return DEFAULT_MARKETPLACE_URL;
    },
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
      if (!value || typeof value !== 'object') throw new Error('市场条目发布响应无效');
      return value as MarketplacePublishEntry;
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
