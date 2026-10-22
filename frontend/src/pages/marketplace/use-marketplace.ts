import { useEffect, useMemo, useState } from 'react';
import type { ProductServices } from '../../app/product/services.ts';
import { useAction, useSnapshot } from '../../app/product/hooks.ts';
import type {
  MarketplaceEntry,
  MarketplaceQuery,
  MarketplaceSnapshot,
} from '../../features/marketplace/index.ts';
import type { PackageKind, PackageMediaType } from '../../services/api/index.ts';
import {
  installBlock,
  installedPackage,
  localPackageEntry,
  localServerEntry,
  newerVersion,
  pluginKind,
} from './presentation.ts';
import { useInstalledMetadata } from './use-installed-metadata.ts';
import { isReleaseEntry, marketInstallationSource, ownedInstallationComponents } from '../../features/plugin-installations/index.ts';
import { localInstallationEntry } from './presentation.ts';

export function useMarketplace(services: ProductServices, active: boolean, installedTab: boolean) {
  const [query, setQuery] = useState<MarketplaceQuery>({ limit: 24 });
  const [catalog, setCatalog] = useState<MarketplaceSnapshot>({
    entries: [],
    total: 0,
    offset: 0,
    limit: 24,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const source = services.marketplace.currentUrl();
  const metadata = useInstalledMetadata(services.marketplace, active && installedTab, generation);
  const defaults = useSnapshot(services.pluginDefaults);
  const serverSource = useMemo(
    () => ({
      snapshot: () => services.runtime.pluginPackages.snapshot('server'),
      subscribe: (listener: Parameters<typeof services.runtime.pluginPackages.subscribe>[1]) =>
        services.runtime.pluginPackages.subscribe('server', listener),
    }),
    [services],
  );
  const browserSource = useMemo(
    () => ({
      snapshot: () => services.runtime.pluginPackages.snapshot('browser'),
      subscribe: (listener: Parameters<typeof services.runtime.pluginPackages.subscribe>[1]) =>
        services.runtime.pluginPackages.subscribe('browser', listener),
    }),
    [services],
  );
  const server = useSnapshot(serverSource),
    browser = useSnapshot(browserSource);
  const serverRuntime = useSnapshot(services.runtime.serverPlugins);
  const installationState = useSnapshot(services.runtime.pluginInstallations);
  const installations = installationState.result?.data ?? [];
  const owned = ownedInstallationComponents(installations);
  const packages = [...(server.result?.data ?? []), ...(browser.result?.data ?? [])];
  const action = useAction();
  useEffect(() => {
    if (!active) {
      action.cancel();
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setCatalog({ entries: [], total: 0, offset: query.offset ?? 0, limit: query.limit ?? 24 });
    const timer = setTimeout(() => {
      void services.marketplace
        .search(query, controller.signal)
        .then((value) => {
          if (!controller.signal.aborted) setCatalog(value);
        })
        .catch((reason: unknown) => {
          if (!controller.signal.aborted)
            setError(reason instanceof Error ? reason.message : '市场加载失败');
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [services, active, query, generation, source]);
  useEffect(() => {
    if (!active || defaults.phase === 'running') return;
    const controller = new AbortController();
    void Promise.all([
      ...(['server', 'browser'] as const).map((kind) => services.runtime.pluginPackages.refresh(kind, controller.signal)),
      services.runtime.serverPlugins.refresh(controller.signal),
      services.runtime.pluginInstallations.refresh(controller.signal),
    ]).catch(() => undefined);
    return () => controller.abort();
  }, [services, active, defaults.phase, generation]);
  function download(entry: MarketplaceEntry) {
    void action.run(
      async (signal) => {
        if (!entry.resource_id) throw new Error('条目没有资源摘要');
        const resource = await services.marketplace.download(
          entry.resource_id,
          signal,
          entry.source,
        );
        signal.throwIfAborted();
        const url = URL.createObjectURL(resource.blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = resource.filename;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
      },
      { pending: '正在下载并校验…', success: '文件已校验并开始保存' },
    );
  }
  function install(entry: MarketplaceEntry) {
    void action.run(
      async (signal) => {
        if (isReleaseEntry(entry)) {
          const source = marketInstallationSource(entry);
          const current = installations.find((item) => item.id === entry.id);
          if (current) {
            if (!newerVersion(entry.version, current.version)) throw new Error('当前条目不是更高版本');
            await services.runtime.pluginInstallations.update(current.id, current.revision, source, signal);
          } else await services.runtime.pluginInstallations.install(source, signal);
          return;
        }
        const blocked = installBlock(entry),
          kind = pluginKind(entry);
        if (blocked || !kind || !entry.resource_id) throw new Error(blocked ?? '插件运行位置无效');
        const installed = installedPackage(entry, packages);
        if (installed && !newerVersion(entry.version, installed.version))
          throw new Error('当前条目不是更高版本');
        const resource = await services.marketplace.download(
          entry.resource_id,
          signal,
          entry.source,
        );
        const mediaType: PackageMediaType = /\.zip$/i.test(resource.filename)
          ? 'application/zip'
          : /\.(tgz|tar\.gz)$/i.test(resource.filename)
            ? 'application/gzip'
            : resource.mediaType === 'application/zip'
              ? 'application/zip'
              : resource.mediaType === 'application/gzip'
                ? 'application/gzip'
                : (() => {
                    throw new Error('插件包必须是 ZIP 或 TGZ');
                  })();
        if (installed)
          await services.runtime.pluginPackages.update(
            kind,
            entry.id,
            resource.blob,
            mediaType,
            signal,
            entry.version,
          );
        else
          await services.runtime.pluginPackages.upload(kind, resource.blob, mediaType, signal, {
            id: entry.id,
            version: entry.version,
          });
      },
      {
        pending: '正在校验并安装插件…',
        success: isReleaseEntry(entry) ? '功能插件已安装并启用' : `插件包已安装；应用方式：${entry.restart_policy === 'none' ? '无需重启，可到市场页「已安装」启用' : '按详情中的重启要求应用，可到市场页「已安装」启用'}`,
      },
    );
  }
  function remove(kind: PackageKind, id: string) {
    void action.run((signal) => services.runtime.pluginPackages.remove(kind, id, signal), {
      pending: '正在卸载插件…',
      success: '插件已卸载',
    });
  }
  function removeInstallation(id: string, revision: string) {
    void action.run((signal) => services.runtime.pluginInstallations.uninstall(id, revision, signal), {
      pending: '正在停用并卸载功能插件…', success: '功能插件已卸载，配置已保留',
    });
  }
  function setInstallationEnabled(id: string, revision: string, enabled: boolean) {
    void action.run((signal) => services.runtime.pluginInstallations.setEnabled(id, revision, enabled, signal), {
      pending: enabled ? '正在启用功能插件…' : '正在停用功能插件…', success: enabled ? '功能插件已启用' : '功能插件已停用',
    });
  }
  const installedEntries = packages.filter((pkg) => !owned.has(`${pkg.kind}:${pkg.id}`)).map((pkg) => {
    const entry = [...metadata.entries, ...catalog.entries]
      .filter((item) => item.id === pkg.id && pluginKind(item) === pkg.kind)
      .reduce<MarketplaceEntry | null>(
        (best, item) => (!best || newerVersion(item.version, best.version) ? item : best),
        null,
      );
    const local = localPackageEntry(pkg, (serverRuntime.result?.data ?? []).find((plugin) => plugin.id === pkg.id));
    return { pkg, installed: { version: pkg.version }, entry: entry && !entry.metadataIssues?.length ? entry : local, removable: true, removeDisabled: false };
  });
  const builtinEntries = (serverRuntime.result?.data ?? []).filter((plugin) => !owned.has(`server:${plugin.id}`) && !packages.some((pkg) => pkg.kind === 'server' && pkg.id === plugin.id)).map((plugin) => ({
    pkg: undefined,
    installed: { version: plugin.version },
    entry: localServerEntry(plugin),
    removable: false,
    removeDisabled: plugin.protected || plugin.state !== 'loaded' || plugin.cleanup_failed,
  }));
  const releaseEntries = installations.map((installation) => {
    const remote = [...metadata.entries, ...catalog.entries].filter((item) => item.id === installation.id && isReleaseEntry(item))
      .reduce<MarketplaceEntry | null>((best, item) => !best || newerVersion(item.version, best.version) ? item : best, null);
    const local = localInstallationEntry(installation);
    return { pkg: undefined, installed: { version: installation.version },
      entry: remote && !remote.metadataIssues?.length ? { ...remote, details: { ...remote.details, ...local.details } } : local,
      removable: true, removeDisabled: false };
  });
  return {
    query,
    setQuery,
    catalog,
    loading,
    error,
    packages,
    installations,
    installedEntries: [...releaseEntries, ...installedEntries, ...builtinEntries],
    action,
    download,
    install,
    remove,
    removeInstallation,
    setInstallationEnabled,
    refresh: () => setGeneration((value) => value + 1),
    installedMetadataError: metadata.error,
    packageError: installationState.error || server.error || browser.error,
  };
}
