import { isIP } from 'node:net';
import { DEFAULT_MARKETPLACE_URL, normalizeMarketplaceSources } from './marketplace.mjs';

function object(value, keys, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new Error(`${label}结构无效或含不支持的字段`);
  return value;
}

export function defaultRootConfiguration() {
  return {
    format_version: 1,
    server: { ip: '0.0.0.0', port: 7030, mcp_port: 7032 },
    marketplace: { sources: [{ name: '本地默认市场', url: DEFAULT_MARKETPLACE_URL }] },
  };
}

// 根配置只包含启动偏好；令牌、业务配置与插件配置由各自边界管理。
export function validateRootConfiguration(value) {
  object(value, ['format_version', 'server', 'marketplace'], '根配置');
  if (value.format_version !== 1) throw new Error('根配置 format_version 必须为 1');
  const defaults = defaultRootConfiguration();
  const server =
    value.server === undefined ? {} : object(value.server, ['ip', 'port', 'mcp_port'], '服务配置');
  const actual = { ...defaults.server, ...server };
  if (typeof actual.ip !== 'string' || !isIP(actual.ip))
    throw new Error('根配置监听地址必须为 IPv4 或 IPv6 地址');
  if (
    ![actual.port, actual.mcp_port].every(
      (port) => Number.isInteger(port) && port >= 1 && port <= 65535,
    )
  )
    throw new Error('根配置端口必须为 1–65535 的整数');
  if (actual.port === actual.mcp_port) throw new Error('前端/API 与 MCP 端口必须不同');
  const market =
    value.marketplace === undefined
      ? defaults.marketplace
      : object(value.marketplace, ['sources'], '市场配置');
  return {
    format_version: 1,
    server: actual,
    marketplace: { sources: normalizeMarketplaceSources(market) },
  };
}
