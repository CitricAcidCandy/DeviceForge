import type {
  MarketplaceKind,
  MarketplaceMcp,
  MarketplacePublishEntry,
  MarketplaceRestart,
} from '../../features/marketplace/index.ts';
import { metadataIssues } from '../../features/marketplace/index.ts';

export type MarketplaceVisibility = 'market' | 'internal';

export interface MarketplaceUploadDraft {
  readonly id: string;
  readonly kind: MarketplaceKind;
  readonly name: string;
  readonly version: string;
  readonly summary: string;
  readonly description: string;
  readonly keywords: string;
  readonly categories: string;
  readonly appliesTo: string;
  readonly supportsMcp: MarketplaceMcp;
  readonly supportsAgent: boolean;
  readonly restartPolicy: MarketplaceRestart;
  readonly platforms: string;
  readonly architectures: string;
  readonly author: string;
  readonly license: string;
  readonly visibility: MarketplaceVisibility;
  readonly details: string;
}

export const initialMarketplaceUploadDraft: MarketplaceUploadDraft = {
  id: '',
  kind: 'plugin',
  name: '',
  version: '1.0.0',
  summary: '',
  description: '',
  keywords: '',
  categories: 'function',
  appliesTo: 'deviceforge',
  supportsMcp: 'none',
  supportsAgent: false,
  restartPolicy: 'none',
  platforms: 'windows',
  architectures: 'x64',
  author: '',
  license: 'MIT',
  visibility: 'market',
  details: '{"plugin_kind":"browser"}',
};

export function splitMetadataList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,，、]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function requireText(value: string, label: string): string {
  const result = value.trim();
  if (!result) throw new Error(`${label}不能为空`);
  return result;
}

export function createMarketplacePublishEntry(
  draft: MarketplaceUploadDraft,
  resourceId: string,
): MarketplacePublishEntry {
  const details = JSON.parse(draft.details) as unknown;
  if (!details || typeof details !== 'object' || Array.isArray(details))
    throw new Error('专属描述必须是 JSON 对象');
  const categories = splitMetadataList(requireText(draft.categories, '分类'));
  const appliesTo = splitMetadataList(requireText(draft.appliesTo, '适用项目'));
  const keywords = splitMetadataList(draft.keywords);
  const platforms = splitMetadataList(draft.platforms);
  const architectures = splitMetadataList(draft.architectures);
  const id = requireText(draft.id, '条目标识');
  if (!/^[a-z0-9][a-z0-9._-]{0,98}$/.test(id))
    throw new Error('条目标识只能使用小写字母、数字、点、下划线和连字符，最多 99 字节');
  if (draft.kind === 'resource' && draft.visibility !== 'internal')
    throw new Error('资源类型必须使用内部可见性');
  const entry: MarketplacePublishEntry = {
    metadata_version: 1,
    id,
    kind: draft.kind,
    name: requireText(draft.name, '名称'),
    version: requireText(draft.version, '版本'),
    summary: requireText(draft.summary, '简介'),
    description: draft.description.trim(),
    keywords,
    categories,
    applies_to: appliesTo,
    supports_mcp: draft.supportsMcp,
    supports_agent: draft.supportsAgent,
    restart_policy: draft.restartPolicy,
    platforms,
    architectures,
    author: draft.author.trim() || null,
    license: draft.license.trim() || null,
    homepage: null,
    visibility: draft.visibility,
    resource_id: resourceId,
    details: details as Record<string, unknown>,
  };
  const issues = metadataIssues(entry);
  if (issues.length) throw new Error(issues.join('；'));
  return entry;
}

export function draftFromMetadata(entry: MarketplacePublishEntry): MarketplaceUploadDraft {
  return {
    id: entry.id, kind: entry.kind, name: entry.name, version: entry.version,
    summary: entry.summary, description: entry.description, keywords: entry.keywords.join(','),
    categories: entry.categories.join(','), appliesTo: entry.applies_to.join(','),
    supportsMcp: entry.supports_mcp, supportsAgent: entry.supports_agent, restartPolicy: entry.restart_policy,
    platforms: entry.platforms.join(','), architectures: entry.architectures.join(','),
    author: entry.author ?? '', license: entry.license ?? '', visibility: entry.visibility ?? 'market',
    details: JSON.stringify(entry.details, null, 2),
  };
}
