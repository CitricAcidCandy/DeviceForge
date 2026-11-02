import { isRecord } from '@deviceforge/business-kit/api';
import type { MarketplacePublishEntry } from '../model/index.ts';
export function isPublishEntry(value: unknown): value is MarketplacePublishEntry {
  return isRecord(value) && value.metadata_version === 1 &&
    ['id', 'name', 'version', 'summary', 'description'].every((key) => typeof value[key] === 'string') &&
    ['plugin', 'tool', 'config', 'distribution', 'resource'].includes(String(value.kind)) &&
    ['none', 'client', 'server', 'both'].includes(String(value.supports_mcp)) &&
    ['none', 'browser_refresh', 'plugin_reload', 'service_restart', 'device_restart'].includes(String(value.restart_policy)) &&
    typeof value.supports_agent === 'boolean' &&
    ['keywords', 'categories', 'applies_to', 'platforms', 'architectures'].every((key) =>
      Array.isArray(value[key]) && value[key].every((entry: unknown) => typeof entry === 'string')) &&
    ['author', 'license', 'homepage', 'resource_id'].every((key) =>
      value[key] === undefined || value[key] === null || typeof value[key] === 'string') &&
    (value.visibility === undefined || value.visibility === 'market' || value.visibility === 'internal') &&
    isRecord(value.details);
}
