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

async function requireOk(response: Response, action: string): Promise<void> {
  if (response.ok) return;
  let detail = `HTTP ${response.status}`;
  try {
    const payload = (await response.json()) as { error?: { message?: unknown } };
    if (typeof payload.error?.message === 'string') detail = payload.error.message;
  } catch {
    // 错误响应不是 JSON 时保留 HTTP 状态，避免遮蔽原始失败。
  }
  throw new Error(`${action}失败：${detail}`);
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
    async search(query: MarketplaceQuery, signal: AbortSignal): Promise<MarketplaceSnapshot> {
      const source = url();
      const response = await fetcher(`${source}/api/v1/catalog?${queryString(query)}`, {
        signal,
        headers: { accept: 'application/json' },
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
      });
      if (!response.ok) throw new Error(`市场目录请求失败：HTTP ${response.status}`);
      return decodeCatalog(await response.json(), source);
    },
    async upload(
      file: MarketplaceUploadFile,
      kind: MarketplaceKind,
      signal: AbortSignal,
      source: string = url(),
    ): Promise<MarketplaceResourceRecord> {
      const response = await fetcher(`${normalizeUrl(source)}/api/v1/resources`, {
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
      });
      await requireOk(response, '资源上传');
      return decodeResource(await response.json());
    },
    async publish(
      entry: MarketplacePublishEntry,
      signal: AbortSignal,
      source: string = url(),
    ): Promise<MarketplacePublishEntry> {
      const response = await fetcher(`${normalizeUrl(source)}/api/v1/catalog`, {
        method: 'POST',
        signal,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify(entry),
        credentials: 'omit',
        redirect: 'error',
      });
      await requireOk(response, '市场条目发布');
      const value = await response.json();
      if (!value || typeof value !== 'object') throw new Error('市场条目发布响应无效');
      return value as MarketplacePublishEntry;
    },
    async download(
      resourceId: string,
      signal: AbortSignal,
      source: string = url(),
    ): Promise<MarketplaceDownloadedResource> {
      if (!/^[a-f0-9]{64}$/i.test(resourceId)) throw new Error('资源摘要无效');
      const response = await fetcher(
        `${normalizeUrl(source)}/api/v1/resources/${encodeURIComponent(resourceId)}`,
        {
          signal,
          headers: { accept: '*/*' },
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
        },
      );
      await requireOk(response, '资源下载');
      return readVerifiedResource(response, resourceId, signal);
    },
  };
}

export type MarketplaceController = ReturnType<typeof createMarketplace>;
