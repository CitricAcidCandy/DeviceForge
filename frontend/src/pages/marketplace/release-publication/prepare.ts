import { releaseArchive } from '../local-import/release-archive.ts';
import { onlineManifest, parseReleaseManifest } from './manifest.ts';
import { digestBytes, resourceSlice, verifyResource } from './resource.ts';
import type { ReleasePublicationPlan, ReleasePublicationResource } from './types.ts';

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
  const variants = [...manifest.components.flatMap((entry) => entry.variants), ...manifest.tools.flatMap((entry) => entry.variants)];
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
  const bytes = new TextEncoder().encode(`${JSON.stringify(onlineManifest(manifest), null, 2)}\n`);
  if (bytes.byteLength > 256 * 1024) throw new Error('在线发布清单超过 256 KiB');
  signal.throwIfAborted();
  return {
    manifest, file, resources: [...resources.values()], manifestSha256: digestBytes(bytes),
    manifestBlob: new Blob([bytes], { type: 'application/json' }),
    totalResourceBytes: [...resources.values()].reduce((total, entry) => total + entry.size, 0),
  };
}
