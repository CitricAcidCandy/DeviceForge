import { readFileSync } from 'node:fs';

export const DEFAULT_MARKETPLACE_URL = 'http://127.0.0.1:7040';

export function validateMarketplaceUrl(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('市场地址不能为空');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('市场地址必须为有效 URL');
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw new Error('市场地址必须为不含凭证、查询参数或片段的 HTTP 地址');
  return parsed.toString().replace(/\/$/, '');
}

export function normalizeMarketplaceSources(value) {
  const sources = Array.isArray(value) ? value : value?.sources;
  if (!Array.isArray(sources) || sources.length === 0 || sources.length > 32)
    throw new Error('市场配置必须包含 1–32 个 sources');
  const seen = new Set();
  return sources.map((source, index) => {
    const url = validateMarketplaceUrl(typeof source === 'string' ? source : source?.url);
    if (seen.has(url)) throw new Error('市场来源重复');
    seen.add(url);
    const name =
      typeof source === 'object' && typeof source?.name === 'string' && source.name.trim()
        ? source.name.trim().slice(0, 80)
        : `市场来源 ${index + 1}`;
    return { name, url };
  });
}

export function readMarketplaceConfig(path = null) {
  if (!path) return [{ name: '本地默认市场', url: DEFAULT_MARKETPLACE_URL }];
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('市场配置读取失败，请检查文件及 JSON 格式');
  }
  return normalizeMarketplaceSources(parsed);
}
