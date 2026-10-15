import type { MarketplaceEntry, MarketplaceQuery, MarketplaceSnapshot } from '../types/index.ts';

export const DEFAULT_MARKETPLACE_URL = 'http://127.0.0.1:7040';
const STORAGE_KEY = 'deviceforge.marketplace.url';

function normalizeUrl(value: string): string {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
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

function decode(value: unknown, source: string, sourceName: string): MarketplaceSnapshot {
  if (!value || typeof value !== 'object') throw new Error('市场目录响应无效');
  const result = value as { entries?: unknown; total?: unknown; offset?: unknown; limit?: unknown };
  if (!Array.isArray(result.entries) || typeof result.total !== 'number') throw new Error('市场目录字段缺失');
  const entries = result.entries.filter((entry): entry is MarketplaceEntry => {
    if (!entry || typeof entry !== 'object') return false;
    const item = entry as Record<string, unknown>;
    return typeof item.id === 'string' && typeof item.name === 'string' && typeof item.version === 'string';
  }).map((entry) => ({ ...entry, source, sourceName }));
  return {
    entries,
    total: result.total,
    offset: typeof result.offset === 'number' ? result.offset : 0,
    limit: typeof result.limit === 'number' ? result.limit : entries.length,
  };
}

function queryString(query: MarketplaceQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  return params.toString();
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
      return decode(await response.json(), source, source);
    },
  };
}

export type MarketplaceController = ReturnType<typeof createMarketplace>;

