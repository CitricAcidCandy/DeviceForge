import { useEffect, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  CloudUpload,
  FolderInput,
  RefreshCw,
  Search,
  SlidersHorizontal,
} from 'lucide-react';
import {
  Button,
  DialogShell,
  Input,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  JsonResult,
} from '../../components/index.ts';
import type { ProductServices } from '../../app/product/services.ts';
import { marketplaceCategories } from '../../features/marketplace/index.ts';
import { isReleaseEntry, installationRequiresRecovery } from '../../features/plugin-installations/index.ts';
import type {
  MarketplaceEntry,
  MarketplaceKind,
  MarketplaceQuery,
} from '../../features/marketplace/index.ts';
import type { PackageInfo } from '../../services/api/index.ts';
import { ActionFeedback } from '../../app/product/feedback.tsx';
import { installedEntry } from './presentation.ts';
import { categoryLabels } from './presentation.ts';
import { useMarketplace } from './use-marketplace.ts';
import { MarketplaceAdvancedFilters } from './components/MarketplaceFilters/index.tsx';
import { MarketplaceCard } from './components/MarketplaceCard/index.tsx';
import { SlotAudit } from './components/SlotAudit/index.tsx';
import { MarketplaceDetail } from './components/MarketplaceDetail/index.tsx';
import { MarketplaceConfiguration } from './components/MarketplaceConfiguration/index.tsx';
import { MarketplaceUploadDialog } from './components/MarketplaceUploadDialog/index.tsx';
import { LocalImportDialog } from './components/LocalImportDialog/index.tsx';
import { InstallationProgress } from './components/InstallationProgress/index.tsx';
import { PluginDependencies } from './components/PluginDependencies/index.tsx';
import { dependencyTarget } from './components/PluginDependencies/target.ts';
import './workspace.css';

const kindNav: readonly { value: MarketplaceKind | undefined; label: string }[] = [
  { value: undefined, label: '全部条目' },
  { value: 'plugin', label: '插件' },
  { value: 'tool', label: '工具' },
  { value: 'config', label: '配置' },
  { value: 'distribution', label: '分发包' },
];

const appliesNav = [
  { value: 'deviceforge', label: 'DeviceForge' },
  { value: 'universal', label: '通用' },
];

const navItem =
  'flex h-7 items-center rounded-md px-2 text-left text-[13px] text-[color:var(--text-body)] hover:bg-[color:var(--surface-hover)] data-[current=true]:bg-[color:var(--card)] data-[current=true]:font-medium data-[current=true]:text-[color:var(--text-strong)] data-[current=true]:ring-1 data-[current=true]:ring-[color:var(--hairline)]';
const chipItem =
  'h-6 rounded-md px-2 text-[12px] text-[color:var(--text-muted)] data-[current=true]:bg-[color:var(--accent)] data-[current=true]:text-[color:var(--primary)]';

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
  const [resources, setResources] = useState(false);
  const [filters, setFilters] = useState(false);
  const [selected, setSelected] = useState<MarketplaceEntry | null>(null);
  const [configuration, setConfiguration] = useState<MarketplaceEntry | null>(null);
  const [dependencies, setDependencies] = useState<MarketplaceEntry | null>(null);
  const [removal, setRemoval] = useState<
    { id: string; kind: 'server' | 'browser'; removable: boolean } |
    { id: string; kind: 'release'; revision: string; removable: true } | null>(null);

  useEffect(() => {
    if (!active) {
      setUpload(false);
      setLocalImport(false);
      setResources(false);
      setFilters(false);
      setSelected(null);
      setConfiguration(null);
      setDependencies(null);
      setRemoval(null);
    }
  }, [active]);

  const renderCard = (
    entry: MarketplaceEntry,
    installed?: Pick<PackageInfo, 'version'>,
    removable = true,
    removeDisabled = false,
  ) => {
    const installation = market.installations.find((item) => item.id === entry.id && isReleaseEntry(entry));
    return (
    <MarketplaceCard
      key={`${entry.source}:${entry.id}:${entry.version}`}
      entry={entry}
      installed={installed}
      onDependencies={installed && dependencyTarget(entry) ? () => setDependencies(entry) : undefined}
      removable={removable}
      removeDisabled={removeDisabled}
      cleanupWarning={entry.details['plugin_kind'] === 'server' && market.cleanupWarnings.includes(entry.id)}
      installation={installation}
      clientState={market.installationClients.find((item) => item.id === installation?.id && item.revision === installation.revision)}
      onSetEnabled={installation ? (enabled) => market.setInstallationEnabled(installation.id, installation.revision, enabled) : undefined}
      onRetryBrowser={installation ? () => market.retryInstallationBrowser(installation.id, installation.revision) : undefined}
      installedTab={tab === 'installed'}
      busy={market.action.pending}
      onDetail={() => setSelected(entry)}
      onDownload={() => market.download(entry)}
      onInstall={() => setSelected(entry)}
      onRemove={() => {
        if (installation) { setRemoval({ id: installation.id, kind: 'release', revision: installation.revision, removable: true }); return; }
        const kind = entry.details['plugin_kind'];
        if (installed && (kind === 'server' || kind === 'browser')) setRemoval({ id: entry.id, kind, removable });
      }}
      onConfigure={() => setConfiguration(entry)}
    />
    );
  };

  // 筛选只有一份来源：所有入口都从当前 query 派生，改完统一回到第一页。
  const patch = (next: Partial<MarketplaceQuery>) => {
    const value: Record<string, unknown> = { ...market.query, offset: 0, ...next };
    for (const key of Object.keys(value)) {
      if (value[key] === undefined || value[key] === '') delete value[key];
    }
    market.setQuery(value as MarketplaceQuery);
  };
  const clear = (key: keyof MarketplaceQuery) => {
    const value: Record<string, unknown> = { ...market.query, offset: 0 };
    delete value[key];
    market.setQuery(value as MarketplaceQuery);
  };
  const categories = market.query.kind
    ? marketplaceCategories[market.query.kind]
    : [...new Set(Object.values(marketplaceCategories).flat())];
  const page = Math.floor(market.catalog.offset / Math.max(1, market.catalog.limit)) + 1;
  const pages = Math.max(1, Math.ceil(market.catalog.total / Math.max(1, market.catalog.limit)));
  const advanced = [
    market.query.supports_mcp,
    market.query.platform,
    market.query.architecture,
    market.query.restart_policy,
    market.query.supports_agent,
  ].filter((value) => value !== undefined).length;

  return (
    <section
      className="product-page marketplace-page flex min-h-0 flex-1 flex-col gap-3.5"
      data-product-page="marketplace"
    >
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-[24px] font-semibold text-[color:var(--text-strong)]">资源市场</h1>
        <div className="flex h-9 min-w-[13rem] max-w-72 flex-1 items-center gap-2 rounded-lg border border-[color:var(--hairline)] bg-[color:var(--card)] px-3">
          <Search className="size-3.5 shrink-0 text-[color:var(--text-ghost)]" aria-hidden="true" />
          <Input
            aria-label="搜索市场"
            placeholder="搜索名称、用途、关键词或作者…"
            value={market.query.q ?? ''}
            onChange={(event) => patch({ q: event.target.value })}
            className="h-full w-full border-0 bg-transparent shadow-none"
          />
        </div>
        <div className="flex flex-1 items-center justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={market.loading} onClick={market.refresh}>
            <RefreshCw className={market.loading ? 'animate-spin' : ''} />
            刷新
          </Button>
          <Button variant="outline" size="sm" onClick={() => setLocalImport(true)}>
            <FolderInput />
            本地导入
          </Button>
          {tab === 'installed' && <Button variant="outline" size="sm" disabled={market.action.pending} onClick={() => setResources(true)}>托管资源</Button>}
          <Button size="sm" onClick={() => setUpload(true)}>
            <CloudUpload />
            上传发布
          </Button>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex h-7 items-center rounded-lg bg-[color:var(--surface-sunken)] p-0.5">
          {[
            { id: 'discover', label: '发现资源' },
            { id: 'installed', label: `已安装 ${market.installedEntries.length}` },
          ].map((entry) => (
            <button
              key={entry.id}
              type="button"
              data-current={tab === entry.id}
              onClick={() => setTab(entry.id)}
              className="h-6 rounded-md px-3 text-[13px] text-[color:var(--text-muted)] data-[current=true]:bg-[color:var(--card)] data-[current=true]:font-medium data-[current=true]:text-[color:var(--text-strong)]"
            >
              {entry.label}
            </button>
          ))}
        </div>
        <span
          className="min-w-0 flex-1 truncate text-right font-mono text-[12px] text-[color:var(--text-ghost)]"
          title={services.marketplace.currentUrl()}
        >
          {services.marketplace.currentUrl()}
        </span>
      </div>

      <div className="flex min-h-0 flex-1 gap-4">
        <aside className="hidden w-42 shrink-0 flex-col gap-0.5 md:flex" aria-label="市场导航">
          {tab === 'discover' ? (
            <>
              <p className="px-2 pb-1.5 text-[12px] text-[color:var(--text-faint)]">条目类型</p>
              {kindNav.map((entry) => (
                <button
                  key={entry.label}
                  type="button"
                  data-current={(market.query.kind ?? undefined) === entry.value}
                  onClick={() => {
                    const next: Record<string, unknown> = { ...market.query, offset: 0 };
                    delete next.kind;
                    delete next.category;
                    if (entry.value) next.kind = entry.value;
                    market.setQuery(next as MarketplaceQuery);
                  }}
                  className={navItem}
                >
                  {entry.label}
                </button>
              ))}
              <p className="px-2 pt-3.5 pb-1.5 text-[12px] text-[color:var(--text-faint)]">适用项目</p>
              {appliesNav.map((entry) => (
                <button
                  key={entry.value}
                  type="button"
                  data-current={market.query.applies_to === entry.value}
                  onClick={() =>
                    market.query.applies_to === entry.value
                      ? clear('applies_to')
                      : patch({ applies_to: entry.value })
                  }
                  className={navItem}
                >
                  {entry.label}
                </button>
              ))}
              <div className="mt-auto border-t border-[color:var(--hairline)] pt-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start text-[12px] text-[color:var(--text-muted)]"
                  onClick={() => setFilters(true)}
                >
                  <SlidersHorizontal />
                  兼容性与能力筛选
                  {advanced > 0 && (
                    <span className="font-mono text-[color:var(--primary)]">{advanced}</span>
                  )}
                </Button>
              </div>
            </>
          ) : (
            <p className="px-2 pt-1 text-[12px] leading-5 text-[color:var(--text-faint)]">
              来自宿主安装目录
              <br />
              {market.installedEntries.length} 项
            </p>
          )}
        </aside>

        <div className="hidden w-px shrink-0 bg-[color:var(--hairline)] md:block" />

        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12px] text-[color:var(--text-faint)]" aria-live="polite">
              {market.loading
                ? '正在检索…'
                : tab === 'discover'
                  ? `${market.catalog.total} 个结果`
                  : `${market.installedEntries.length} 项已安装`}
            </span>
            {tab === 'discover' && (
              <div className="flex flex-wrap items-center gap-1">
                <button
                  type="button"
                  data-current={!market.query.category}
                  onClick={() => clear('category')}
                  className={chipItem}
                >
                  全部分类
                </button>
                {categories.slice(0, 8).map((value) => (
                  <button
                    key={value}
                    type="button"
                    data-current={market.query.category === value}
                    onClick={() =>
                      market.query.category === value ? clear('category') : patch({ category: value })
                    }
                    className={chipItem}
                  >
                    {categoryLabels[value] ?? value}
                  </button>
                ))}
              </div>
            )}
            <div className="flex-1" />
            {tab === 'discover' && pages > 1 && (
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={market.loading || !market.catalog.offset}
                  onClick={() => patch({ offset: Math.max(0, market.catalog.offset - market.catalog.limit) })}
                >
                  <ChevronLeft />
                  上一页
                </Button>
                <span className="font-mono text-[12px] text-[color:var(--text-faint)]">
                  {page} / {pages}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={
                    market.loading ||
                    market.catalog.offset + market.catalog.limit >= market.catalog.total
                  }
                  onClick={() => patch({ offset: market.catalog.offset + market.catalog.limit })}
                >
                  下一页
                  <ChevronRight />
                </Button>
              </div>
            )}
          </div>

          {market.error && (
            <div
              className="flex flex-wrap items-center gap-3 rounded-xl border border-[color:var(--warning)]/40 bg-[color:var(--warning)]/8 px-4 py-3 text-[13px] text-[color:var(--text-body)]"
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

          {market.packageError ? (
            <p className="text-[13px] text-[color:var(--warning)]" role="alert">
              安装目录读取失败，请刷新重试。
            </p>
          ) : null}
          {tab === 'installed' && market.installedMetadataError && (
            <p className="text-[12px] text-[color:var(--text-muted)]" role="status">
              市场描述暂不可用，仍可配置和管理已安装的插件。
            </p>
          )}

          {tab === 'installed' && <SlotAudit services={services} />}

          <div
            className="grid min-h-0 flex-1 content-start gap-2.5 overflow-auto pb-1 [grid-template-columns:repeat(auto-fill,minmax(18.75rem,1fr))]"
            aria-busy={market.loading}
          >
            {tab === 'discover'
              ? market.catalog.entries.map((entry) => renderCard(entry, installedEntry(entry, market.packages, market.installations)))
              : market.installedEntries.map(({ entry, installed, removable, removeDisabled }) =>
                  renderCard(entry, installed, removable, removeDisabled),
                )}
          </div>

          {tab === 'discover' && !market.loading && !market.error && market.catalog.entries.length === 0 && (
            <div className="flex min-h-40 items-center justify-center rounded-xl border border-dashed border-[color:var(--hairline-strong)]">
              <p className="text-[13px] text-[color:var(--text-faint)]">没有匹配的资源</p>
            </div>
          )}
          {tab === 'installed' && !market.installedEntries.length && (
            <div className="flex min-h-40 items-center justify-center rounded-xl border border-dashed border-[color:var(--hairline-strong)]">
              <p className="text-[13px] text-[color:var(--text-faint)]">还没有安装插件</p>
            </div>
          )}
        </div>
      </div>

      <ActionFeedback {...market.action} />
      {market.action.pending && <InstallationProgress value={market.installationProgress} />}

      <Sheet open={active && filters} onOpenChange={setFilters}>
        <SheetContent side="right" className="w-full gap-0 bg-[color:var(--card)] p-0 sm:max-w-90">
          <SheetHeader className="border-b border-[color:var(--hairline)] p-5">
            <SheetTitle className="text-[16px] text-[color:var(--text-strong)]">
              兼容性与能力筛选
            </SheetTitle>
            <SheetDescription className="text-[12px] text-[color:var(--text-faint)]">
              只在发现资源时生效；切换条目类型会清空分类。
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-auto p-5">
            <MarketplaceAdvancedFilters query={market.query} onChange={market.setQuery} />
          </div>
        </SheetContent>
      </Sheet>

      <MarketplaceDetail
        entry={active ? selected : null}
        installed={selected ? installedEntry(selected, market.packages, market.installations) : undefined}
        recoveryBlocked={selected ? market.installations.some((item) => item.id === selected.id && installationRequiresRecovery(item)) : false}
        busy={market.action.pending}
        onDebug={selected && installedEntry(selected, market.packages, market.installations) && services.runtime.debugger
          ? () => {
            const entry = selected;
            if (!entry) return;
            const release = market.installations.find(item => item.id === entry.id && isReleaseEntry(entry));
            const kind = entry.details['plugin_kind'];
            const candidates = release ? release.components.map(item => ({ target_kind: item.kind, plugin_id: item.id }))
              : (kind === 'browser' || kind === 'server') ? [{ target_kind: kind, plugin_id: entry.id }] : [];
            void market.action.run(async signal => {
              if (candidates.length === 0) throw new Error('该条目没有可选择的浏览器或服务器组件');
              await services.runtime.extensions.callService('host.debugger', '1', {
                action: 'focus', input: { candidates, installation_id: release?.id ?? null },
              }, signal);
              setSelected(null);
            });
          } : undefined}
        onDependencies={selected && installedEntry(selected, market.packages, market.installations) && dependencyTarget(selected)
          ? () => { setDependencies(selected); setSelected(null); } : undefined}
        onClose={() => setSelected(null)}
        onDownload={() => {
          if (selected) market.download(selected);
        }}
        onInstall={() => {
          if (selected) market.install(selected);
        }}
      />
      <PluginDependencies client={services.client} target={active && dependencies ? dependencyTarget(dependencies) : null}
        onUpdated={async (signal) => { await services.runtime.pluginInstallations.restore(signal); market.refresh(); }}
        name={dependencies?.name ?? ''} onClose={() => setDependencies(null)} />
      <MarketplaceConfiguration
        key={configuration ? `${configuration.source}:${configuration.id}` : 'closed'}
        entry={active ? configuration : null}
        installations={market.installations}
        services={services}
        onClose={() => setConfiguration(null)}
        onApplied={market.refresh}
      />
      <MarketplaceUploadDialog
        open={active && upload}
        onOpenChange={setUpload}
        marketplace={services.marketplace}
        onPublished={market.refresh}
      />
      <LocalImportDialog open={active && localImport} onOpenChange={setLocalImport} services={services} onImported={market.refresh} />
      <DialogShell open={active && resources} onOpenChange={setResources} title="托管资源引用与清理"
        description="先检查服务器托管的组件、工具和缓存引用，再清理确认没有引用的资源。正在运行和安装恢复仍引用的资源会保留。"
        footer={<><Button variant="outline" onClick={() => setResources(false)}>关闭</Button>
          <Button variant="outline" disabled={market.action.pending} onClick={() => market.cleanupResources(true)}>检查资源引用</Button>
          {market.cleanupResult?.dryRun && <Button disabled={market.action.pending} onClick={() => market.cleanupResources(false)}>清理未引用资源</Button>}</>}>
        {market.action.pending && <InstallationProgress value={market.installationProgress} />}
        {market.cleanupResult && <><p role="status">{market.cleanupResult.dryRun ? '检查完成，可查看候选资源。执行清理时服务器会重新核对引用。' : '资源清理任务已完成。'}</p>
          <JsonResult value={market.cleanupResult.data} />
          {market.cleanupResult.logId && <p>日志 ID：<code>{market.cleanupResult.logId}</code></p>}</>}
      </DialogShell>
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
                if (removal?.kind === 'release') market.removeInstallation(removal.id, removal.revision);
                else if (removal?.removable) market.remove(removal.kind, removal.id);
                else if (removal)
                  void market.action.run((signal) => services.runtime.serverPlugins.unload(removal.id, signal));
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
