import type { MarketplaceEntry, MarketplaceSnapshot } from '../types/index.ts';
import { metadataIssues } from '../utils/metadata.ts';

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function list(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function decodeCatalog(value: unknown, source: string): MarketplaceSnapshot {
  if (!object(value) || !Array.isArray(value['entries']) || typeof value['total'] !== 'number')
    throw new Error('市场目录字段缺失');
  const entries: MarketplaceEntry[] = [];
  for (const raw of value['entries']) {
    if (!object(raw) || !text(raw['id'])) continue;
    const kind = raw['kind'];
    if (
      kind !== 'plugin' &&
      kind !== 'tool' &&
      kind !== 'config' &&
      kind !== 'distribution' &&
      kind !== 'resource'
    )
      continue;
    const mcp = raw['supports_mcp'];
    const restart = raw['restart_policy'];
    const issues: string[] = [];
    for (const key of ['name', 'version', 'summary', 'description']) {
      if (typeof raw[key] !== 'string' || (key !== 'description' && !text(raw[key]).trim()))
        issues.push(`${key}描述缺失或无效`);
    }
    if (mcp !== 'none' && mcp !== 'client' && mcp !== 'server' && mcp !== 'both')
      issues.push('MCP 描述缺失或无效');
    if (
      !['none', 'browser_refresh', 'plugin_reload', 'service_restart', 'device_restart'].includes(
        text(restart),
      )
    )
      issues.push('重启策略缺失或无效');
    if (typeof raw['supports_agent'] !== 'boolean') issues.push('Agent 描述缺失');
    for (const key of ['keywords', 'categories', 'applies_to', 'platforms', 'architectures']) {
      if (!Array.isArray(raw[key]) || raw[key].some((item) => typeof item !== 'string'))
        issues.push(`${key}描述缺失或无效`);
    }
    if (!object(raw['details'])) issues.push('专属描述无效');
    const entry: MarketplaceEntry = {
      metadata_version: typeof raw['metadata_version'] === 'number' ? raw['metadata_version'] : 0,
      id: text(raw['id']),
      kind,
      name: text(raw['name']) || text(raw['id']),
      version: text(raw['version']),
      summary: text(raw['summary']),
      description: text(raw['description']),
      keywords: list(raw['keywords']),
      categories: list(raw['categories']),
      applies_to: list(raw['applies_to']),
      supports_mcp: mcp === 'client' || mcp === 'server' || mcp === 'both' ? mcp : 'none',
      supports_agent: raw['supports_agent'] === true,
      restart_policy:
        restart === 'browser_refresh' ||
        restart === 'plugin_reload' ||
        restart === 'service_restart' ||
        restart === 'device_restart'
          ? restart
          : 'none',
      platforms: list(raw['platforms']),
      architectures: list(raw['architectures']),
      author: text(raw['author']) || null,
      license: text(raw['license']) || null,
      homepage: text(raw['homepage']) || null,
      resource_id: text(raw['resource_id']) || null,
      visibility: raw['visibility'] === 'internal' ? 'internal' : 'market',
      details: object(raw['details']) ? raw['details'] : {},
      source,
      sourceName: source,
    };
    entries.push({ ...entry, metadataIssues: [...issues, ...metadataIssues(entry)] });
  }
  return {
    entries: entries.filter((entry) => entry.visibility !== 'internal'),
    total: value['total'],
    offset: typeof value['offset'] === 'number' ? value['offset'] : 0,
    limit: typeof value['limit'] === 'number' ? value['limit'] : entries.length,
  };
}
