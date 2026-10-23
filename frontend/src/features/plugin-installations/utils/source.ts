import type { MarketplaceEntry } from '../../marketplace/index.ts';
import type { InstallationSource } from '../types/index.ts';

export function isReleaseEntry(entry: MarketplaceEntry): boolean {
  return entry.kind === 'plugin' && (entry.details['release_format_version'] === 1 || entry.details['release_format'] === 1);
}

export function marketInstallationSource(entry: MarketplaceEntry): InstallationSource {
  if (!isReleaseEntry(entry)) throw new Error('市场条目没有声明统一发布格式');
  if (entry.metadataIssues?.length) throw new Error('市场条目元数据不完整');
  if (!entry.id.trim() || !entry.version.trim()) throw new Error('发布标识或版本为空');
  if (!entry.resource_id || !/^[a-f0-9]{64}$/.test(entry.resource_id)) throw new Error('发布清单缺少有效的小写 SHA-256 摘要');
  const base = new URL(entry.source);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash)
    throw new Error('市场来源必须是不含凭证、查询参数或片段的 HTTP 地址');
  const sourceUrl = `${base.toString().replace(/\/$/, '')}/api/v1/resources/${entry.resource_id}`;
  return { kind: 'market', sourceUrl, releaseId: entry.id, version: entry.version, releaseDigest: entry.resource_id };
}
