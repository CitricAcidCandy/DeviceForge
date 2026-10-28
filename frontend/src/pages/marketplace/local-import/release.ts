import { jsonObject } from '../../../shared/jobs/index.ts';
import type { JsonData } from '../../../shared/jobs/index.ts';
import { safeRelativePath } from '../upload-preparation/rules.ts';
import { releaseArchive } from './release-archive.ts';
import { validateRelease, releaseResources } from '@deviceforge/plugin-manifest';

export interface LocalReleaseIdentity {
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly componentCount: number;
  readonly toolCount: number;
}
// 本地只读 ZIP 目录及受限清单，资源摘要和展开由服务器流式安装计划验证。
export async function inspectLocalRelease(file: File, signal: AbortSignal): Promise<LocalReleaseIdentity | null> {
  signal.throwIfAborted();
  if (!/\.zip$/i.test(file.name)) return null;
  if (!file.size || file.size > 4 * 1024 * 1024 * 1024) throw new Error('离线插件 ZIP 须为 4 GiB 以内的非空文件');
  const archive = await releaseArchive(file, signal);
  if (!archive) return null;
  const archiveEntries = archive.entries;
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(archive.manifest));
  if (!jsonObject(value) || (value.format_version !== 1 && value.format_version !== 2) || value.host_api_version !== 2 ||
      typeof value.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(value.id) ||
      typeof value.version !== 'string' || !value.version.trim() || typeof value.name !== 'string' || !value.name.trim() ||
      typeof value.description !== 'string' || !Array.isArray(value.components) || !value.components.length ||
      (value.tools !== undefined && !Array.isArray(value.tools)))
    throw new Error('离线插件的 release.json 缺少有效格式、名称或组件');
  function verifyResources(items: readonly JsonData[]) {
    for (const item of items) {
      if (!jsonObject(item) || !Array.isArray(item.variants) || !item.variants.length) throw new Error('发布组件或工具缺少资源变体');
      for (const variant of item.variants) {
        signal.throwIfAborted();
        if (!jsonObject(variant) || typeof variant.path !== 'string' || typeof variant.platform !== 'string' ||
            !['zip', 'tgz', 'file'].includes(String(variant.format)) ||
            typeof variant.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(variant.sha256) ||
            typeof variant.size !== 'number' || !Number.isSafeInteger(variant.size) || variant.size <= 0)
          throw new Error('离线发布资源声明无效');
        const path = safeRelativePath(variant.path);
        const resource = archiveEntries.get(path.toLowerCase());
        if (!resource || resource.name !== path || resource.size !== variant.size)
          throw new Error(`离线发布资源缺失或大小不一致：${path}`);
      }
    }
  }
  verifyResources(value.components);
  const tools = Array.isArray(value.tools) ? value.tools : [];
  verifyResources(tools);
  if (value.format_version === 2) {
    const release = validateRelease(value);
    for (const resource of releaseResources(release)) {
      const entry = archiveEntries.get(resource.path.toLowerCase());
      if (!entry || entry.name !== resource.path || entry.size !== resource.size)
        throw new Error(`离线发布资源缺失或大小不一致：${resource.path}`);
    }
  }
  signal.throwIfAborted();
  return { id: value.id, version: value.version, name: value.name, componentCount: value.components.length, toolCount: tools.length };
}
