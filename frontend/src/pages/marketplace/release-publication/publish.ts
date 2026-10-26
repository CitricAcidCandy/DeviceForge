import { metadataIssues } from '../../../features/marketplace/index.ts';
import { ApiError } from '../../../services/api/index.ts';
import type { MarketplaceController, MarketplacePublishEntry, MarketplaceResourceRecord } from '../../../features/marketplace/index.ts';
import { onlineManifest } from './manifest.ts';
import { digestBytes } from './resource.ts';
import type { ReleasePublicationPlan, ReleasePublicationProgress, ReleasePublicationResult } from './types.ts';

function publicationEntry(plan: ReleasePublicationPlan, metadata: MarketplacePublishEntry): MarketplacePublishEntry {
  const manifest = plan.manifest;
  if (metadata.id !== manifest.id || metadata.version !== manifest.version || metadata.name !== manifest.name ||
      metadata.description !== manifest.description || metadata.kind !== 'plugin' ||
      metadata.resource_id !== plan.manifestSha256)
    throw new Error('市场条目身份必须与完整发布清单及摘要一致，请重新检查 ZIP');
  const entry: MarketplacePublishEntry = {
    ...metadata, visibility: 'market', resource_id: plan.manifestSha256,
    details: { ...metadata.details, release_format_version: manifest.format_version, host_api_version: manifest.host_api_version },
  };
  const issues = metadataIssues(entry);
  if (issues.length) throw new Error(`市场资料无效：${issues.join('；')}`);
  return entry;
}

function uploadedResource(record: MarketplaceResourceRecord, digest: string, size: number): void {
  if (record.id !== digest || record.sha256 !== digest || record.size !== size)
    throw new Error('市场返回的资源摘要或大小不匹配，已停止提交目录');
}

export async function publishReleasePublication(
  plan: ReleasePublicationPlan,
  metadata: MarketplacePublishEntry,
  marketplace: MarketplaceController,
  signal: AbortSignal,
  onProgress?: (progress: ReleasePublicationProgress) => void,
): Promise<ReleasePublicationResult> {
  signal.throwIfAborted();
  const entry = publicationEntry(plan, metadata);
  const manifestBytes = new TextEncoder().encode(`${JSON.stringify(onlineManifest(plan.manifest), null, 2)}\n`);
  if (plan.manifestBlob.size !== manifestBytes.byteLength || digestBytes(manifestBytes) !== plan.manifestSha256 ||
      plan.manifestBlob.size > 256 * 1024 ||
      digestBytes(new Uint8Array(await plan.manifestBlob.arrayBuffer())) !== plan.manifestSha256)
    throw new Error('发布计划已变化，请重新检查完整 ZIP');
  const source = marketplace.currentUrl();
  const remoteResources = plan.remoteResources ?? [];
  const totalResources = plan.resources.length + remoteResources.length;
  let completedResources = 0, completedBytes = 0, reusedCount = 0;
  function progress(stage: ReleasePublicationProgress['stage'], current?: string) {
    signal.throwIfAborted();
    onProgress?.({ stage, completedResources, totalResources, completedBytes,
      totalBytes: plan.totalResourceBytes, ...(current === undefined ? {} : { current }) });
    signal.throwIfAborted();
  }
  progress('checking');
  const capabilities = await marketplace.releaseCapabilities(signal, source);
  signal.throwIfAborted();
  if (!capabilities.release_publication.format_versions.includes(plan.manifest.format_version))
    throw new ApiError('protocol', 'marketplace_upgrade_required', '市场服务器尚未支持此发布清单版本，请先升级市场服务器');
  const limit = capabilities.release_publication.resource_max_bytes;
  if (plan.manifestBlob.size > limit || remoteResources.some((resource) => resource.size > limit) ||
    plan.resources.some((resource) => resource.size > limit || resource.blob.size !== resource.size))
    throw new Error('发布资源超过当前市场单资源上限，或计划大小已变化');
  // 先核对所有远端摘要闭包，不从官方地址抓包，也不把远端缺失伪装成本地可上传。
  for (const resource of remoteResources) {
    progress('checking', resource.path);
    if (!await marketplace.probeResource(resource.sha256, resource.size, signal, source))
      throw new Error(`当前市场缺少依赖摘要资源，请内嵌原包或先上传：${resource.sha256}`);
    ++completedResources;
    ++reusedCount;
    completedBytes += resource.size;
  }
  for (const resource of plan.resources) {
    progress('uploading', resource.path);
    const reused = await marketplace.probeResource(resource.sha256, resource.size, signal, source);
    signal.throwIfAborted();
    if (reused) ++reusedCount;
    else {
      const file = new File([resource.blob], resource.path.split('/').at(-1) ?? resource.sha256, { type: 'application/octet-stream' });
      const record = await marketplace.upload(file, 'resource', signal, source);
      signal.throwIfAborted();
      uploadedResource(record, resource.sha256, resource.size);
    }
    ++completedResources;
    completedBytes += resource.size;
    progress('uploading', resource.path);
  }
  progress('manifest', 'release.json');
  if (!await marketplace.probeResource(plan.manifestSha256, plan.manifestBlob.size, signal, source)) {
    signal.throwIfAborted();
    const record = await marketplace.upload(new File([plan.manifestBlob], 'release.json', { type: 'application/json' }), 'plugin', signal, source);
    signal.throwIfAborted();
    uploadedResource(record, plan.manifestSha256, plan.manifestBlob.size);
  }
  progress('catalog');
  await marketplace.publish(entry, signal, source);
  signal.throwIfAborted();
  progress('complete');
  return { resourceCount: totalResources, reusedCount, manifestSha256: plan.manifestSha256, source };
}
