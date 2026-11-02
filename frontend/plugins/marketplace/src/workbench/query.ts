import type { MarketplaceQuery } from '../model/index.ts';

/** 所有筛选入口收敛为稀疏查询，保留 false 和零偏移，移除空文本。 */
export function marketplaceQuery(value: Readonly<Record<string, unknown>>): MarketplaceQuery {
  const { kind, supports_mcp: mcp, restart_policy: restart } = value;
  return {
    ...(kind === 'plugin' || kind === 'tool' || kind === 'config' || kind === 'distribution' || kind === 'resource' ? { kind } : {}),
    ...(mcp === 'none' || mcp === 'client' || mcp === 'server' || mcp === 'both' ? { supports_mcp: mcp } : {}),
    ...(restart === 'none' || restart === 'browser_refresh' || restart === 'plugin_reload' || restart === 'service_restart' || restart === 'device_restart' ? { restart_policy: restart } : {}),
    ...(typeof value.supports_agent === 'boolean' ? { supports_agent: value.supports_agent } : {}),
    ...(typeof value.q === 'string' && value.q ? { q: value.q } : {}),
    ...(typeof value.category === 'string' && value.category ? { category: value.category } : {}),
    ...(typeof value.applies_to === 'string' && value.applies_to ? { applies_to: value.applies_to } : {}),
    ...(typeof value.platform === 'string' && value.platform ? { platform: value.platform } : {}),
    ...(typeof value.architecture === 'string' && value.architecture ? { architecture: value.architecture } : {}),
    ...(typeof value.offset === 'number' && Number.isSafeInteger(value.offset) && value.offset >= 0 ? { offset: value.offset } : {}),
    ...(typeof value.limit === 'number' && Number.isSafeInteger(value.limit) && value.limit > 0 ? { limit: value.limit } : {}),
  };
}
