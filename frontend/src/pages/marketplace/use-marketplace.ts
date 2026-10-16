import { useEffect, useMemo, useState } from 'react';
import type { ProductServices } from '../../app/product/services.ts';
import { useAction, useSnapshot } from '../../app/product/hooks.ts';
import type { MarketplaceEntry, MarketplaceQuery, MarketplaceSnapshot } from '../../features/marketplace/index.ts';
import type { PackageKind, PackageMediaType } from '../../services/api/index.ts';
import { installBlock, installedPackage, localPackageEntry, newerVersion, pluginKind } from './presentation.ts';
import { useInstalledMetadata } from './use-installed-metadata.ts';

export function useMarketplace(services: ProductServices, active: boolean, installedTab: boolean) {
  const [query, setQuery] = useState<MarketplaceQuery>({ limit: 24 });
  const [catalog, setCatalog] = useState<MarketplaceSnapshot>({ entries: [], total: 0, offset: 0, limit: 24 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const source = services.marketplace.currentUrl();
  const metadata = useInstalledMetadata(services.marketplace, active && installedTab, generation);
  const defaults = useSnapshot(services.pluginDefaults);
  const serverSource = useMemo(() => ({ snapshot: () => services.runtime.pluginPackages.snapshot('server'), subscribe: (listener: Parameters<typeof services.runtime.pluginPackages.subscribe>[1]) => services.runtime.pluginPackages.subscribe('server', listener) }), [services]);
  const browserSource = useMemo(() => ({ snapshot: () => services.runtime.pluginPackages.snapshot('browser'), subscribe: (listener: Parameters<typeof services.runtime.pluginPackages.subscribe>[1]) => services.runtime.pluginPackages.subscribe('browser', listener) }), [services]);
  const server = useSnapshot(serverSource), browser = useSnapshot(browserSource);
  const packages = [...(server.result?.data ?? []), ...(browser.result?.data ?? [])];
  const action = useAction();
  useEffect(() => {
    if (!active) { action.cancel(); return; }
    const controller = new AbortController();
    setLoading(true); setError(null); setCatalog({ entries: [], total: 0, offset: query.offset ?? 0, limit: query.limit ?? 24 });
    const timer = setTimeout(() => {
      void services.marketplace.search(query, controller.signal).then((value) => { if (!controller.signal.aborted) setCatalog(value); })
        .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '市场加载失败'); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [services, active, query, generation, source]);
  useEffect(() => {
    if (!active || defaults.phase === 'running') return;
    const controller = new AbortController();
    void Promise.all((['server', 'browser'] as const).map((kind) => services.runtime.pluginPackages.refresh(kind, controller.signal)))
      .catch(() => undefined);
    return () => controller.abort();
  }, [services, active, defaults.phase, generation]);
  function download(entry: MarketplaceEntry) {
    void action.run(async (signal) => {
      if (!entry.resource_id) throw new Error('条目没有资源摘要');
      const resource = await services.marketplace.download(entry.resource_id, signal, entry.source);
      signal.throwIfAborted();
      const url = URL.createObjectURL(resource.blob);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = resource.filename;
      document.body.append(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    }, { pending: '正在下载并校验…', success: '文件已校验并开始保存' });
  }
  function install(entry: MarketplaceEntry) {
    void action.run(async (signal) => {
      const blocked = installBlock(entry), kind = pluginKind(entry);
      if (blocked || !kind || !entry.resource_id) throw new Error(blocked ?? '插件运行位置无效');
      const installed = installedPackage(entry, packages);
      if (installed && !newerVersion(entry.version, installed.version)) throw new Error('当前条目不是更高版本');
      const resource = await services.marketplace.download(entry.resource_id, signal, entry.source);
      const mediaType: PackageMediaType = /\.zip$/i.test(resource.filename) ? 'application/zip' : /\.(tgz|tar\.gz)$/i.test(resource.filename) ? 'application/gzip' : resource.mediaType === 'application/zip' ? 'application/zip' : resource.mediaType === 'application/gzip' ? 'application/gzip' : (() => { throw new Error('插件包必须是 ZIP 或 TGZ'); })();
      if (installed) await services.runtime.pluginPackages.update(kind, entry.id, resource.blob, mediaType, signal, entry.version);
      else await services.runtime.pluginPackages.upload(kind, resource.blob, mediaType, signal, { id: entry.id, version: entry.version });
    }, { pending: '正在校验并安装插件…', success: `插件包已安装；应用方式：${entry.restart_policy === 'none' ? '无需重启，可到插件页启用' : '按详情中的重启要求应用，可到插件页启用'}` });
  }
  function remove(kind: PackageKind, id: string) {
    void action.run((signal) => services.runtime.pluginPackages.remove(kind, id, signal), { pending: '正在卸载插件…', success: '插件已卸载' });
  }
  const installedEntries = packages.map((pkg) => {
    const entry = [...metadata.entries, ...catalog.entries].filter((item) => item.id === pkg.id && pluginKind(item) === pkg.kind)
      .reduce<MarketplaceEntry | null>((best, item) => !best || newerVersion(item.version, best.version) ? item : best, null);
    return { pkg, entry: entry ?? localPackageEntry(pkg) };
  });
  return { query, setQuery, catalog, loading, error, packages, installedEntries, action, download, install, remove,
    refresh: () => setGeneration((value) => value + 1),
    installedMetadataError: metadata.error,
    packageError: server.error || browser.error };
}
