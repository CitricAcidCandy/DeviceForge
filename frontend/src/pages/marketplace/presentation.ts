import type {
  MarketplaceEntry,
  MarketplaceKind,
  MarketplaceRestart,
} from '../../features/marketplace/index.ts';
import type { PackageInfo, PackageKind, PluginInfo } from '../../services/api/index.ts';
import type { SettingsSection } from '../../features/settings/index.ts';

export const kindLabels: Record<MarketplaceKind, string> = {
  plugin: '插件',
  tool: '工具',
  config: '配置',
  distribution: '分发包',
  resource: '内部资源',
};
export const categoryLabels: Record<string, string> = {
  function: '功能',
  theme: '主题',
  ui: '界面',
  integration: '集成',
  runtime: '运行时',
  analysis: '分析',
  device: '设备',
  build: '构建',
  utility: '实用',
  preset: '预设',
  performance: '性能',
  workflow: '工作流',
};
export const restartLabels: Record<MarketplaceRestart, string> = {
  none: '无需重启',
  browser_refresh: '刷新浏览器',
  plugin_reload: '重载插件',
  service_restart: '重启服务',
  device_restart: '重启设备',
};
export const mcpLabels = {
  none: '不支持 MCP',
  client: 'MCP 客户端',
  server: 'MCP 服务端',
  both: 'MCP 双向',
};

export function pluginKind(entry: MarketplaceEntry): PackageKind | null {
  const value = entry.details['plugin_kind'];
  return entry.kind === 'plugin' && (value === 'server' || value === 'browser') ? value : null;
}

export function installedPackage(
  entry: MarketplaceEntry,
  packages: readonly PackageInfo[],
): PackageInfo | undefined {
  const kind = pluginKind(entry);
  return packages.find((pkg) => pkg.id === entry.id && pkg.kind === kind);
}

// 按语义版本判断升级，拒绝把旧版本或未知版本顺序误报为更新。
export function newerVersion(candidate: string, installed: string): boolean {
  const parse = (value: string) => /^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?(?:\+[\w.-]+)?$/.exec(value);
  const next = parse(candidate),
    current = parse(installed);
  if (!next || !current) return false;
  for (let index = 1; index <= 3; index++) {
    const difference = Number(next[index]) - Number(current[index]);
    if (difference) return difference > 0;
  }
  if (!next[4] || !current[4]) return !!current[4] && !next[4];
  const left = next[4].split('.'),
    right = current[4].split('.');
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const a = left[index],
      b = right[index];
    if (a === b) continue;
    if (a === undefined) return false;
    if (b === undefined) return true;
    if (/^\d+$/.test(a) && /^\d+$/.test(b)) return Number(a) > Number(b);
    if (/^\d+$/.test(a)) return false;
    if (/^\d+$/.test(b)) return true;
    return a > b;
  }
  return false;
}

export function configurationTarget(entry: MarketplaceEntry): SettingsSection | null {
  const value = entry.details['configuration'];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!('scope' in value) || !('owner_id' in value) || !('section' in value)) return null;
  const { scope, owner_id, section } = value;
  if (
    (scope !== 'user' && scope !== 'workspace') ||
    typeof owner_id !== 'string' ||
    !owner_id.trim() ||
    typeof section !== 'string' ||
    !section.trim()
  )
    return null;
  return { scope, owner_id, section };
}

export function installBlock(entry: MarketplaceEntry): string | null {
  if (entry.metadataIssues?.length) return '元数据不完整，无法安装';
  if (!entry.resource_id || !/^[a-f0-9]{64}$/i.test(entry.resource_id)) return '缺少有效资源摘要';
  if (!pluginKind(entry))
    return entry.kind === 'plugin' ? '作者未声明插件运行位置' : '此条目提供文件下载';
  return null;
}

export function localPackageEntry(pkg: PackageInfo, plugin?: PluginInfo): MarketplaceEntry {
  const metadata = pkg.kind === 'server' && plugin?.id === pkg.id && plugin.version === pkg.version
    ? plugin.metadata
    : undefined;
  return {
    metadata_version: 1,
    id: pkg.id,
    kind: 'plugin',
    name: metadata?.name ?? pkg.id,
    version: pkg.version,
    summary: metadata?.summary ?? '已安装的本地插件，当前市场未提供描述',
    description: metadata?.description ?? '',
    keywords: [],
    categories: [],
    applies_to: metadata ? ['deviceforge'] : [],
    supports_mcp: 'none',
    supports_agent: false,
    restart_policy: 'plugin_reload',
    platforms: [],
    architectures: [],
    details: { plugin_kind: pkg.kind },
    source: '',
    sourceName: '本地安装',
    ...(metadata ? {} : { metadataIssues: ['缺少市场元数据'] }),
  };
}

export function localServerEntry(plugin: PluginInfo): MarketplaceEntry {
  return { metadata_version: 1, id: plugin.id, kind: 'plugin', name: plugin.metadata?.name ?? plugin.id, version: plugin.version,
    summary: plugin.metadata?.summary ?? '宿主服务器插件，配置来自插件自身声明', description: plugin.metadata?.description ?? '', keywords: [], categories: [], applies_to: ['deviceforge'],
    supports_mcp: 'none', supports_agent: false, restart_policy: 'plugin_reload', platforms: [], architectures: [],
    details: { plugin_kind: 'server' }, source: '', sourceName: '宿主插件目录',
    ...(plugin.metadata ? {} : { metadataIssues: ['缺少市场元数据'] }) };
}

export function describeDetail(value: unknown): string {
  if (value === null || value === undefined) return '未声明';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}
