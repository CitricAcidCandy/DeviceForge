import { utf8Length } from './encoding.mjs';
// 市场展示资料只从统一清单派生，不重复维护身份和版本。
export function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label}必须为对象`);
  return value;
}
export function fields(value, allowed, label) {
  object(value, label);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${label}含未知或重复声明字段：${unknown.join('、')}`);
  return value;
}
export function text(value, maximum, label, multiline = false) {
  if (typeof value !== 'string' || !value.trim() || utf8Length(value) > maximum ||
      (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(value))
    throw new Error(`${label}为空、含控制字符或超过 ${maximum} 字节`);
  return value;
}
function strings(value, maximum, label) {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label}数组无效或超限`);
  value.forEach((item) => text(item, 100, label));
  if (new Set(value.map((item) => item.trim().toLowerCase())).size !== value.length)
    throw new Error(`${label}重复`);
  return value;
}
export function marketMetadata(declaration, identity = declaration, details = {}) {
  const market = fields(declaration.market ?? {}, [
    'summary', 'keywords', 'categories', 'applies_to', 'supports_mcp', 'supports_agent',
    'restart_policy', 'author', 'license', 'homepage', 'visibility', 'details',
  ], 'market');
  const summary = market.summary ?? [...declaration.description.replace(/\s+/g, ' ').trim()].reduce((result, character) =>
    utf8Length(result + character) <= 400 ? result + character : result, '');
  const metadata = {
    metadata_version: 1, id: identity.id, version: identity.version, kind: 'plugin',
    name: declaration.name, description: declaration.description,
    summary: text(summary, 400, '市场简介'),
    keywords: strings(market.keywords ?? [], 64, '市场关键词'),
    categories: strings(market.categories ?? ['function'], 16, '市场分类'),
    applies_to: strings(market.applies_to ?? ['deviceforge'], 64, '市场适用对象'),
    supports_mcp: market.supports_mcp ?? 'none', supports_agent: market.supports_agent ?? false,
    restart_policy: market.restart_policy ?? 'none', visibility: market.visibility ?? 'market',
    platforms: [], architectures: [],
    details: { ...object(market.details ?? {}, 'market.details'), ...details },
  };
  const entries = identity.entrypoints ? [identity] : declaration.components ?? [];
  const platforms = entries.flatMap((component) => Object.keys(component.entrypoints ?? {}));
  metadata.platforms = [...new Set(platforms.map((platform) => platform.split('-')[0]))];
  metadata.architectures = [...new Set(platforms.map((platform) => platform === 'any' ? 'any' : platform.split('-').slice(1).join('-')))];
  if (!metadata.applies_to.length || metadata.categories.some((category) =>
      !['function', 'theme', 'ui', 'integration'].includes(category)) ||
      !['none', 'client', 'server', 'both'].includes(metadata.supports_mcp) ||
      typeof metadata.supports_agent !== 'boolean' ||
      !['none', 'browser_refresh', 'plugin_reload', 'service_restart', 'device_restart'].includes(metadata.restart_policy) ||
      !['market', 'internal'].includes(metadata.visibility)) throw new Error('市场枚举或适用对象无效');
  for (const key of ['author', 'license', 'homepage']) {
    if (market[key] !== undefined) metadata[key] = text(market[key], key === 'homepage' ? 2048 : 200, `market.${key}`);
  }
  if (metadata.homepage) {
    const url = new URL(metadata.homepage);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error('market.homepage 必须为无凭据 HTTP/HTTPS 地址');
  }
  return metadata;
}
