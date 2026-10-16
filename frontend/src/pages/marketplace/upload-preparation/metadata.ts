import type { MarketplacePublishEntry } from '../../../features/marketplace/index.ts';
import { metadataIssues } from '../../../features/marketplace/index.ts';
import { jsonObject, safeRelativePath } from './rules.ts';
import type { ArchiveFile, UploadInspection } from './types.ts';

export function importedMetadata(file: ArchiveFile | undefined): MarketplacePublishEntry | null {
  if (!file) return null;
  const value = jsonObject(file.bytes, 'market.json');
  const strings = ['id', 'name', 'kind', 'version', 'summary', 'description', 'supports_mcp', 'restart_policy'];
  const lists = ['keywords', 'categories', 'applies_to', 'platforms', 'architectures'];
  if (value.metadata_version !== 1 || strings.some(key => typeof value[key] !== 'string') ||
      lists.some(key => !Array.isArray(value[key]) || !value[key].every((item: unknown) => typeof item === 'string')) ||
      !['plugin', 'tool', 'config', 'distribution', 'resource'].includes(String(value.kind)) ||
      !['none', 'client', 'server', 'both'].includes(String(value.supports_mcp)) ||
      !['none', 'browser_refresh', 'plugin_reload', 'service_restart', 'device_restart'].includes(String(value.restart_policy)) ||
      typeof value.supports_agent !== 'boolean' || !value.details || typeof value.details !== 'object' || Array.isArray(value.details))
    throw new Error('包内 market.json 字段不完整或类型不正确');
  const entry = value as unknown as MarketplacePublishEntry;
  const issues = metadataIssues(entry);
  if (issues.length) throw new Error(`包内市场描述无效：${issues.join('；')}`);
  return entry;
}

export function pluginIdentity(files: readonly ArchiveFile[], prefix: string): UploadInspection['identity'] {
  const find = (path: string) => files.find(file => file.path === prefix + path);
  const pkgFile = find('package.json');
  if (!pkgFile) throw new Error('插件包根目录缺少 package.json，请选择已构建的便携插件目录');
  const pkg = jsonObject(pkgFile.bytes, 'package.json');
  const descriptor = pkg.deviceforge;
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) throw new Error('package.json 缺少 deviceforge 便携包声明');
  const desc = descriptor as Record<string, unknown>;
  if ((desc.kind !== 'server' && desc.kind !== 'browser') || typeof desc.manifest !== 'string') throw new Error('插件种类或运行清单路径无效');
  const manifestFile = find(safeRelativePath(desc.manifest));
  if (!manifestFile) throw new Error('包内缺少插件运行清单');
  const manifest = jsonObject(manifestFile.bytes, '插件运行清单');
  if (typeof manifest.id !== 'string' || typeof manifest.version !== 'string' || pkg.version !== manifest.version) throw new Error('插件清单与 package.json 的版本不一致');
  if (!desc.entrypoints || typeof desc.entrypoints !== 'object' || Array.isArray(desc.entrypoints)) throw new Error('插件缺少平台入口');
  const entrypoints = Object.values(desc.entrypoints);
  if (!entrypoints.length) throw new Error('插件缺少可执行入口');
  for (const entry of entrypoints) {
    if (!entry || typeof entry !== 'object' || !('path' in entry) || typeof entry.path !== 'string') throw new Error('插件入口声明无效');
    const path = safeRelativePath(entry.path);
    if (!find(path) || /\.(tsx?|jsx)$/i.test(path)) throw new Error(`入口 ${path} 尚未构建，请先构建插件再上传`);
  }
  return { id: manifest.id, version: manifest.version, kind: desc.kind };
}

export function checkIdentity(identity: UploadInspection['identity'], metadata: MarketplacePublishEntry): void {
  if (!identity) return;
  if (metadata.kind !== 'plugin' || metadata.id !== identity.id || metadata.version !== identity.version)
    throw new Error('市场类型、插件 ID 或版本与运行清单不一致');
  if (metadata.details.plugin_kind !== identity.kind) throw new Error('插件运行位置与包内清单不一致');
}
