import { useEffect, useState } from 'react';
import { CloudUpload, FolderInput, RefreshCw } from 'lucide-react';
import { Button, DialogShell } from '../../components/index.ts';
import type { ProductServices } from '../../app/product/services.ts';
import type { MarketplaceEntry } from '../../features/marketplace/index.ts';
import type { PackageInfo } from '../../services/api/index.ts';
import { ActionFeedback } from '../../app/product/feedback.tsx';
import { installedPackage } from './presentation.ts';
import { useMarketplace } from './use-marketplace.ts';
import { MarketplaceFilters } from './components/MarketplaceFilters/index.tsx';
import { MarketplaceCard } from './components/MarketplaceCard/index.tsx';
import { MarketplaceDetail } from './components/MarketplaceDetail/index.tsx';
import { MarketplaceConfiguration } from './components/MarketplaceConfiguration/index.tsx';
import { MarketplaceUploadDialog } from './components/MarketplaceUploadDialog/index.tsx';
import { LocalImportDialog } from './components/LocalImportDialog/index.tsx';
import './workspace.css';

export function MarketplacePage({
  services,
  active = true,
}: {
  services: ProductServices;
  active?: boolean;
}) {
  const [tab, setTab] = useState('discover');
  const market = useMarketplace(services, active, tab === 'installed');
  const [upload, setUpload] = useState(false);
  const [localImport, setLocalImport] = useState(false);
  const [selected, setSelected] = useState<MarketplaceEntry | null>(null);
  const [configuration, setConfiguration] = useState<MarketplaceEntry | null>(null);
  const [removal, setRemoval] = useState<{ id: string; kind: 'server' | 'browser'; removable: boolean } | null>(null);
  useEffect(() => {
    if (!active) {
      setUpload(false);
      setLocalImport(false);
      setSelected(null);
      setConfiguration(null);
      setRemoval(null);
    }
  }, [active]);
  const renderCard = (entry: MarketplaceEntry, installed?: Pick<PackageInfo, 'version'>, removable = true, removeDisabled = false) => (
    <MarketplaceCard
      key={`${entry.source}:${entry.id}:${entry.version}`}
      entry={entry}
      installed={installed}
      removable={removable}
      removeDisabled={removeDisabled}
      installedTab={tab === 'installed'}
      busy={market.action.pending}
      onDetail={() => setSelected(entry)}
      onDownload={() => market.download(entry)}
      onInstall={() => setSelected(entry)}
      onRemove={() => {
        const kind = entry.details['plugin_kind'];
        if (installed && (kind === 'server' || kind === 'browser')) setRemoval({ id: entry.id, kind, removable });
      }}
      onConfigure={() => setConfiguration(entry)}
    />
  );
  const card = renderCard;
  const tabs = [
    { id: 'discover', label: '发现资源' },
    { id: 'installed', label: `已安装 ${market.installedEntries.length}` },
  ] as const;
  return (
    <section
      className="product-page marketplace-page flex min-h-[560px] flex-1 flex-col gap-3"
      data-product-page="marketplace"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[22px] font-semibold text-[color:var(--text-strong)]">资源市场</h1>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={market.loading} onClick={market.refresh}>
            <RefreshCw className={market.loading ? 'animate-spin' : ''} />
            刷新
          </Button>
          <Button variant="outline" size="sm" onClick={() => setLocalImport(true)}>
            <FolderInput />
            本地导入
          </Button>
          <Button size="sm" onClick={() => setUpload(true)}>
            <CloudUpload />
            上传发布
          </Button>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex h-9 items-center rounded-md bg-[color:var(--surface-sunken)] p-0.5">
          {tabs.map((entry) => (
            <button
              key={entry.id}
              type="button"
              data-current={tab === entry.id}
              onClick={() => setTab(entry.id)}
              className="h-8 rounded-[4px] px-3 text-[12px] text-[color:var(--text-muted)] data-[current=true]:bg-[color:var(--card)] data-[current=true]:text-[color:var(--text-strong)]"
            >
              {entry.label}
            </button>
          ))}
        </div>
        <span
          className="min-w-0 truncate font-mono text-[11px] text-[color:var(--text-ghost)]"
          title={services.marketplace.currentUrl()}
        >
          {services.marketplace.currentUrl()}
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto pb-1">
        {tab === 'discover' ? (
          <>
            <MarketplaceFilters query={market.query} onChange={market.setQuery} />
            <div className="flex items-baseline gap-2 px-1">
              <span className="text-[11px] text-[color:var(--text-faint)]" aria-live="polite">
                {market.loading ? '正在检索…' : `${market.catalog.total} 个结果`}
              </span>
            </div>
            {market.error && (
              <div
                className="flex flex-wrap items-center gap-3 rounded-[12px] border border-[color:var(--warning)]/40 bg-[color:var(--warning)]/8 px-4 py-3 text-[12px] text-[color:var(--text-body)]"
                role="alert"
              >
                <span className="text-[color:var(--warning)]">资源服务不可用</span>
                <span className="min-w-0 truncate">{market.error}</span>
                <div className="flex-1" />
                <Button variant="outline" size="sm" onClick={market.refresh}>
                  重试
                </Button>
              </div>
            )}
            <div
              className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3"
              aria-busy={market.loading}
            >
              {market.catalog.entries.map((entry) =>
                card(entry, installedPackage(entry, market.packages)),
              )}
            </div>
            {!market.loading && !market.error && market.catalog.entries.length === 0 && (
              <div className="flex min-h-48 items-center justify-center rounded-[12px] border border-dashed border-[color:var(--hairline-strong)]">
                <p className="text-[12px] text-[color:var(--text-faint)]">没有匹配的资源</p>
              </div>
            )}
            <div className="flex items-center justify-center gap-3 py-1">
              <Button
                variant="ghost"
                size="sm"
                disabled={market.loading || !market.catalog.offset}
                onClick={() =>
                  market.setQuery({
                    ...market.query,
                    offset: Math.max(0, market.catalog.offset - market.catalog.limit),
                  })
                }
              >
                上一页
              </Button>
              <span className="font-mono text-[11px] text-[color:var(--text-faint)]">
                第 {Math.floor(market.catalog.offset / Math.max(1, market.catalog.limit)) + 1} 页
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={
                  market.loading ||
                  market.catalog.offset + market.catalog.limit >= market.catalog.total
                }
                onClick={() =>
                  market.setQuery({
                    ...market.query,
                    offset: market.catalog.offset + market.catalog.limit,
                  })
                }
              >
                下一页
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-baseline gap-2 px-1">
              <span className="text-[11px] text-[color:var(--text-faint)]">来自宿主安装目录</span>
            </div>
            {market.packageError ? (
              <p className="px-1 text-[12px] text-[color:var(--warning)]" role="alert">
                安装目录读取失败，请刷新重试。
              </p>
            ) : null}
            {market.installedMetadataError && (
              <p className="px-1 text-[11px] text-[color:var(--text-muted)]" role="status">
                市场描述暂不可用，仍可配置和管理已安装的插件。
              </p>
            )}
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
              {market.installedEntries.map(({ entry, installed, removable, removeDisabled }) =>
                card(entry, installed, removable, removeDisabled),
              )}
            </div>
            {!market.installedEntries.length && (
              <div className="flex min-h-48 items-center justify-center rounded-[12px] border border-dashed border-[color:var(--hairline-strong)]">
                <p className="text-[12px] text-[color:var(--text-faint)]">还没有安装插件</p>
              </div>
            )}
          </>
        )}
      </div>

      <ActionFeedback {...market.action} />
      <MarketplaceDetail
        entry={active ? selected : null}
        installed={selected ? installedPackage(selected, market.packages) : undefined}
        busy={market.action.pending}
        onClose={() => setSelected(null)}
        onDownload={() => {
          if (selected) market.download(selected);
        }}
        onInstall={() => {
          if (selected) market.install(selected);
        }}
      />
      <MarketplaceConfiguration
        entry={active ? configuration : null}
        services={services}
        onClose={() => setConfiguration(null)}
      />
      <MarketplaceUploadDialog
        open={active && upload}
        onOpenChange={setUpload}
        marketplace={services.marketplace}
        onPublished={market.refresh}
      />
      <LocalImportDialog open={active && localImport} onOpenChange={setLocalImport} services={services} />
      <DialogShell
        open={active && !!removal}
        onOpenChange={(open) => {
          if (!open) setRemoval(null);
        }}
        title={removal?.removable ? '卸载插件' : '停用宿主插件'}
        description={`确认${removal?.removable ? '卸载' : '停用'} ${removal?.id ?? ''}？插件将停止并撤销其扩展。`}
        footer={
          <>
            <Button variant="outline" onClick={() => setRemoval(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (removal?.removable) market.remove(removal.kind, removal.id);
                else if (removal) void market.action.run((signal) => services.runtime.serverPlugins.unload(removal.id, signal));
                setRemoval(null);
              }}
            >
              确认{removal?.removable ? '卸载' : '停用'}
            </Button>
          </>
        }
      />
    </section>
  );
}
