import type { MarketplaceKind, MarketplacePublishEntry } from '../types/index.ts';

export const marketplaceCategories: Record<MarketplaceKind, readonly string[]> = {
  plugin: ['function', 'theme', 'ui', 'integration'],
  tool: ['runtime', 'analysis', 'device', 'build', 'utility'],
  config: ['preset', 'device', 'performance', 'theme', 'workflow'],
  distribution: [], resource: [],
};

export function metadataIssues(entry: MarketplacePublishEntry): string[] {
  const issues: string[] = [];
  if (entry.metadata_version !== 1) issues.push('元数据版本不受支持');
  if (!/^[a-z0-9][a-z0-9_-]{0,99}$/.test(entry.id)) issues.push('条目标识无效');
  for (const [label, value, limit] of [
    ['名称', entry.name, 160], ['版本', entry.version, 80], ['简介', entry.summary, 400],
  ] as const) {
    if (!value.trim() || new TextEncoder().encode(value).length > limit) issues.push(`${label}缺失或过长`);
  }
  if (new TextEncoder().encode(entry.description).length > 20_000) issues.push('完整描述过长');
  if (!entry.applies_to.length) issues.push('缺少适用项目');
  for (const [label, values, limit] of [
    ['关键词', entry.keywords, 64], ['分类', entry.categories, 16],
  ] as const) {
    if (values.length > limit || values.some((value) => !value.trim())) issues.push(`${label}无效`);
    if (new Set(values.map((value) => value.trim().toLowerCase())).size !== values.length)
      issues.push(`${label}重复`);
  }
  const allowed = marketplaceCategories[entry.kind];
  if (entry.categories.some((value) => !/^[a-z0-9_-]+$/.test(value) || (allowed.length > 0 && !allowed.includes(value))))
    issues.push('分类不适用于该类型');
  if (entry.kind === 'tool' && !('tool_type' in entry.details)) issues.push('缺少工具类型');
  if (entry.kind === 'config' && (!('config_type' in entry.details) || !('schema_version' in entry.details)))
    issues.push('缺少配置对象类型或 schema 版本');
  if (entry.kind === 'distribution' && (!('package_name' in entry.details) || !('entrypoint' in entry.details)))
    issues.push('缺少包名或可执行入口');
  return issues;
}
