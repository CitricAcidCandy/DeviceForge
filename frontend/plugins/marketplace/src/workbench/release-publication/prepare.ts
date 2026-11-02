import { releaseArchive } from '../local-import/release-archive.ts';
import { onlineManifest, parseReleaseManifest } from './manifest.ts';
import { digestBytes, resourceSlice, verifyResource } from './resource.ts';
import type { ReleasePublicationPlan, ReleasePublicationResource } from './types.ts';
import { isRemoteDependencySource } from './dependency-manifest.ts';

export async function prepareReleasePublication(file: File, signal: AbortSignal): Promise<ReleasePublicationPlan> {
  signal.throwIfAborted();
  if (!/\.zip$/i.test(file.name) || !file.size || file.size > 4 * 1024 ** 3)
    throw new Error('请选择 4 GiB 以内的非空完整功能插件 ZIP');
  const archive = await releaseArchive(file, signal);
  if (!archive) throw new Error('完整功能插件 ZIP 根目录必须包含 release.json');
  const manifest = parseReleaseManifest(archive.manifest);
  const resources = new Map<string, ReleasePublicationResource>();
  const paths = new Map<string, string>();
  const ranges: { start: number; end: number }[] = [];
  const remoteResources = new Map<string, Omit<ReleasePublicationResource, 'blob'>>();
  const variants = [...manifest.components.flatMap((entry) => entry.variants), ...manifest.tools.flatMap((entry) => entry.variants)];
  for (const dependency of manifest.dependencies?.dependencies ?? []) for (const source of dependency.sources) {
    if (source.kind !== 'market') continue;
    // 打包器也用 blobs/摘要命名内嵌原包；存在 ZIP 成员时必须先核验，不能绕到远端复用。
    if (!archive.entries.has(source.url.toLowerCase()) && isRemoteDependencySource(source)) {
      const previous = remoteResources.get(source.sha256);
      if (previous && previous.size !== source.size) throw new Error('相同依赖摘要声明不同大小');
      remoteResources.set(source.sha256, { sha256: source.sha256, size: source.size, path: source.url });
    } else variants.push({ ...source, path: source.url });
  }
  for (const variant of variants) {
    signal.throwIfAborted();
    const entry = archive.entries.get(variant.path.toLowerCase());
    if (!entry || entry.name !== variant.path || entry.size !== variant.size)
      throw new Error(`完整 ZIP 资源缺失或大小不一致：${variant.path}`);
    const previous = resources.get(variant.sha256);
    if (previous && previous.size !== variant.size) throw new Error('相同资源摘要声明不同大小');
    const pathDigest = paths.get(variant.path);
    if (pathDigest && pathDigest !== variant.sha256) throw new Error('相同资源路径声明不同摘要');
    if (pathDigest) continue;
    const slice = await resourceSlice(file, entry, archive.dataEnd, signal);
    ranges.push({ start: slice.start, end: slice.end });
    const blob = await verifyResource(slice.blob, entry, variant.sha256, signal);
    paths.set(variant.path, variant.sha256);
    if (!previous) resources.set(variant.sha256, { sha256: variant.sha256, size: variant.size, path: variant.path, blob });
  }
  ranges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < ranges.length; ++index) {
    const previous = ranges[index - 1], current = ranges[index];
    if (previous && current && previous.end > current.start) throw new Error('完整 ZIP 资源数据范围重叠');
  }
  for (const [digest, remote] of remoteResources) {
    const local = resources.get(digest);
    if (local && local.size !== remote.size) throw new Error('本地与远端依赖摘要声明不同大小');
    if (local) remoteResources.delete(digest);
  }
  const bytes = new TextEncoder().encode(`${JSON.stringify(onlineManifest(manifest), null, 2)}\n`);
  if (bytes.byteLength > 256 * 1024) throw new Error('在线发布清单超过 256 KiB');
  signal.throwIfAborted();
  return {
    manifest, file, resources: [...resources.values()], remoteResources: [...remoteResources.values()], manifestSha256: digestBytes(bytes),
    manifestBlob: new Blob([bytes], { type: 'application/json' }),
    totalResourceBytes: [...resources.values(), ...remoteResources.values()].reduce((total, entry) => total + entry.size, 0),
  };
}
