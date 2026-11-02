import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useAction, useSnapshot } from './hooks.ts';
import type { MarketplaceServices } from './services.ts';
import type { MarketplaceEntry, MarketplaceQuery, MarketplaceSnapshot } from '../model/index.ts';
import type { PackageMediaType } from './api/index.ts';
import {
  installBlock, installedPackage, localInstallationEntry, localPackageEntry, localServerEntry, newerVersion, pluginKind,
} from './presentation.ts';
import { isReleaseEntry, marketInstallationSource, ownedInstallationComponents } from './installations.ts';
import { useInstalledMetadata } from './use-installed-metadata.ts';

export function useMarketplace(services: MarketplaceServices, active: boolean, installedTab: boolean) {
  const [query, setQuery] = useState<MarketplaceQuery>({ limit: 24 });
  const [catalog, setCatalog] = useState<MarketplaceSnapshot>({ entries: [], total: 0, offset: 0, limit: 24 });
  const [loading, setLoading] = useState(false), [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const [cleanupResult, setCleanupResult] = useState<{ readonly data: unknown; readonly logId: string | null; readonly dryRun: boolean } | null>(null);
  const source = useSyncExternalStore(
    services.marketplace.subscribe, services.marketplace.currentUrl, services.marketplace.currentUrl,
  );
  const state = useSnapshot(services.installed), action = useAction();
  const progressSource = useMemo(() => ({
    snapshot: services.installations.progressSnapshot,
    subscribe: (listener: (value: ReturnType<typeof services.installations.progressSnapshot>) => void) =>
      services.installations.subscribeProgress(() => listener(services.installations.progressSnapshot())),
  }), [services]);
  const installationProgress = useSnapshot(progressSource);
  const metadata = useInstalledMetadata(services.marketplace, active && installedTab, generation);
  const installations = state.browser?.installations ?? [], clients = state.browser?.clients ?? [];
  const packages = [...state.serverPackages, ...(state.browser?.packages ?? [])];
  const owned = ownedInstallationComponents(installations);
  useEffect(() => {
    if (!active) { action.cancel(); return; }
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, services.context.signal]);
    setLoading(true); setError(null);
    setCatalog({ entries: [], total: 0, offset: query.offset ?? 0, limit: query.limit ?? 24 });
    const timer = setTimeout(() => {
      void services.marketplace.search(query, signal).then((value) => {
        if (!signal.aborted) setCatalog(value);
      }).catch((reason: unknown) => {
        if (!signal.aborted) setError(reason instanceof Error ? reason.message : '市场加载失败');
      }).finally(() => { if (!signal.aborted) setLoading(false); });
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [services, active, query, source, generation]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void services.installed.refresh(controller.signal).catch(() => undefined);
    return () => controller.abort();
  }, [services, active, generation]);
  const refresh = () => setGeneration((value) => value + 1);
  function download(entry: MarketplaceEntry) {
    void action.run(async (signal) => {
      if (!entry.resource_id) throw new Error('条目没有资源摘要');
      const resource = await services.marketplace.download(entry.resource_id, signal, entry.source);
      signal.throwIfAborted();
      services.download(resource.blob, resource.filename);
    }, { pending: '正在下载并校验…', success: '文件已校验并开始保存' });
  }
  function install(entry: MarketplaceEntry) {
    void action.run(async (signal) => {
      if (isReleaseEntry(entry)) {
        const source = marketInstallationSource(entry), current = installations.find((item) => item.id === entry.id);
        if (current) {
          if (!newerVersion(entry.version, current.version)) throw new Error('当前条目不是更高版本');
          await services.installations.update(current.id, current.revision, source, signal);
        } else await services.installations.install(source, signal);
      } else {
        const blocked = installBlock(entry), kind = pluginKind(entry);
        if (blocked || !kind || !entry.resource_id) throw new Error(blocked ?? '插件运行位置无效');
        const previous = installedPackage(entry, packages);
        if (previous && !newerVersion(entry.version, previous.version)) throw new Error('当前条目不是更高版本');
        const resource = await services.marketplace.download(entry.resource_id, signal, entry.source);
        const mediaType: PackageMediaType = /\.zip$/iu.test(resource.filename) ? 'application/zip' :
          /\.(tgz|tar\.gz)$/iu.test(resource.filename) ? 'application/gzip' :
            resource.mediaType === 'application/zip' || resource.mediaType === 'application/gzip' ? resource.mediaType :
              (() => { throw new Error('插件包必须是 ZIP 或 TGZ'); })();
        if (previous) await services.packages.update(kind, entry.id, resource.blob, mediaType, signal, entry.version);
        else await services.packages.upload(kind, resource.blob, mediaType, signal, { id: entry.id, version: entry.version });
      }
      await services.installed.refresh(signal);
    }, { pending: '正在校验并安装插件…', success: isReleaseEntry(entry) ? '安装调用完成，请核对安装与本客户端状态' : '插件包已安装，请在已安装列表核对状态并启用' });
  }
  const bestMetadata = (id: string, test: (entry: MarketplaceEntry) => boolean) =>
    [...metadata.entries, ...catalog.entries].filter((entry) => entry.id === id && test(entry))
      .reduce<MarketplaceEntry | null>((best, item) => !best || newerVersion(item.version, best.version) ? item : best, null);
  const localEntries = packages.filter((pkg) => !owned.has(`${pkg.kind}:${pkg.id}`)).map((pkg) => {
    const remote = bestMetadata(pkg.id, (entry) => pluginKind(entry) === pkg.kind);
    return { installed: { version: pkg.version },
      entry: remote && !remote.metadataIssues?.length ? remote : localPackageEntry(pkg, state.serverPlugins.find((entry) => entry.id === pkg.id)),
      removable: true, removeDisabled: false };
  });
  const builtinEntries = state.serverPlugins.filter((plugin) => !owned.has(`server:${plugin.id}`) &&
    !packages.some((pkg) => pkg.kind === 'server' && pkg.id === plugin.id)).map((plugin) => ({
      installed: { version: plugin.version }, entry: localServerEntry(plugin), removable: false,
      removeDisabled: plugin.protected || plugin.state !== 'loaded',
    }));
  const releaseEntries = installations.map((installation) => {
    const remote = bestMetadata(installation.id, isReleaseEntry), local = localInstallationEntry(installation);
    return { installed: { version: installation.version },
      entry: remote && !remote.metadataIssues?.length ? { ...remote, details: { ...remote.details, ...local.details } } : local,
      removable: true, removeDisabled: false };
  });
  const bundledEntries = (state.browser?.bundled ?? []).filter((entry) => !['external', 'unavailable'].includes(entry.phase) &&
    !owned.has(`browser:${entry.id}`) && !packages.some((pkg) => pkg.kind === 'browser' && pkg.id === entry.id)).map((entry) => ({
      installed: { version: entry.version }, removable: false, removeDisabled: false,
      entry: {
        metadata_version: 1, id: entry.id, kind: 'plugin' as const, name: entry.title, version: entry.version,
        summary: entry.error ?? '官方随附能力，按当前偏好启用；停用后仍可从恢复入口重新启用。',
        description: '', keywords: [], categories: ['function'], applies_to: ['deviceforge'],
        supports_mcp: 'none' as const, supports_agent: false, restart_policy: 'none' as const,
        platforms: [], architectures: [], source: '', sourceName: '官方随附',
        details: { plugin_kind: 'browser', bundled: true },
      },
    }));
  return {
    query, setQuery, catalog, loading, error, packages, installations, installationClients: clients,
    installationProgress,
    installedEntries: [...bundledEntries, ...releaseEntries, ...localEntries, ...builtinEntries],
    directoryKnown: state.known, directoryPending: state.pending,
    cleanupWarnings: state.serverPlugins.filter((entry) => entry.cleanup_failed).map((entry) => entry.id),
    bundledEnabled: (id: string) => state.browser?.bundled.find((entry) => entry.id === id)?.phase === 'loaded',
    setBundledEnabled(id: string, enabled: boolean) {
      void action.run(async (signal) => {
        await services.management.request({ action: 'setEnabled', source: 'bundled', id, enabled }, signal);
        await services.installed.refresh(signal);
      });
    },
    action, download, install,
    remove(kind: 'server' | 'browser', id: string) {
      void action.run(async (signal) => { await services.packages.remove(kind, id, signal); await services.installed.refresh(signal); });
    },
    removeInstallation(id: string, revision: string) {
      void action.run(async (signal) => { await services.installations.uninstall(id, revision, signal); await services.installed.refresh(signal); });
    },
    setInstallationEnabled(id: string, revision: string, enabled: boolean) {
      void action.run(async (signal) => { await services.installations.setEnabled(id, revision, enabled, signal); await services.installed.refresh(signal); });
    },
    retryInstallationBrowser(id: string, revision: string) {
      void action.run(async (signal) => { await services.installations.retryBrowser(id, revision, signal); await services.installed.refresh(signal); });
    },
    cleanupResult,
    cleanupResources(dryRun: boolean) {
      setCleanupResult(null);
      void action.run(async (signal) => {
        const result = await services.installations.cleanup(dryRun, signal);
        signal.throwIfAborted(); setCleanupResult({ ...result, dryRun }); return result;
      });
    },
    refresh, installedMetadataError: metadata.error, packageError: state.error,
  };
}
