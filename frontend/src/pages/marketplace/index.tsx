import { useEffect, useState } from 'react';
import { CloudUpload, RefreshCw, Store, PackageCheck } from 'lucide-react';
import {
  Button,
  DialogShell,
  EmptyState,
  PageTitle,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '../../components/index.ts';
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
  const [selected, setSelected] = useState<MarketplaceEntry | null>(null);
  const [configuration, setConfiguration] = useState<MarketplaceEntry | null>(null);
  const [removal, setRemoval] = useState<{ id: string; kind: 'server' | 'browser'; removable: boolean } | null>(null);
  useEffect(() => {
    if (!active) {
      setUpload(false);
      setSelected(null);
      setConfiguration(null);
      setRemoval(null);
    }
  }, [active]);
  const card = (entry: MarketplaceEntry, installed?: Pick<PackageInfo, 'version'>, removable = true, removeDisabled = false) => (
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
  return (
    <section className="marketplace-page">
      <PageTitle title="资源市场" description="发现插件与工具，搭建自己的设备工坊">
        <Button variant="outline" disabled={market.loading} onClick={market.refresh}>
          <RefreshCw className={market.loading ? 'animate-spin' : ''} />
          刷新
        </Button>
        <Button onClick={() => setUpload(true)}>
          <CloudUpload />
          上传发布
        </Button>
      </PageTitle>
      <Tabs value={tab} onValueChange={setTab}>
        <div className="marketplace-tabs-heading">
          <TabsList variant="line">
            <TabsTrigger value="discover">
              <Store />
              发现资源
            </TabsTrigger>
            <TabsTrigger value="installed">
              <PackageCheck />
              已安装 <span className="marketplace-count">{market.installedEntries.length}</span>
            </TabsTrigger>
          </TabsList>
          <span className="marketplace-source" title={services.marketplace.currentUrl()}>
            来源：{services.marketplace.currentUrl()}
          </span>
        </div>
        <TabsContent value="discover">
          <MarketplaceFilters query={market.query} onChange={market.setQuery} />
          <div className="marketplace-results-heading">
            <h2>探索工坊资源</h2>
            <span aria-live="polite">
              {market.loading ? '正在检索…' : `${market.catalog.total} 个结果`}
            </span>
          </div>
          {market.error && (
            <div className="marketplace-warning" role="alert">
              {market.error}
              <p>请确认独立资源服务已启动，可在设置中修改市场地址。</p>
              <Button variant="outline" onClick={market.refresh}>
                重试
              </Button>
            </div>
          )}
          <div className="marketplace-card-grid" aria-busy={market.loading}>
            {market.catalog.entries.map((entry) =>
              card(entry, installedPackage(entry, market.packages)),
            )}
          </div>
          {!market.loading && !market.error && market.catalog.entries.length === 0 && (
            <EmptyState
              title="没有找到匹配资源"
              description="试试其他关键词或减少筛选条件，也可以上传首个资源。"
            />
          )}
          <div className="marketplace-pagination">
            <Button
              variant="outline"
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
            <span>
              第 {Math.floor(market.catalog.offset / Math.max(1, market.catalog.limit)) + 1} 页
            </span>
            <Button
              variant="outline"
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
        </TabsContent>
        <TabsContent value="installed">
          <div className="marketplace-results-heading">
            <h2>已安装的插件</h2>
            <span>来自宿主实际安装目录</span>
          </div>
          {market.packageError ? (
            <p className="form-error" role="alert">
              安装目录读取失败，请刷新重试。
            </p>
          ) : null}
          {market.installedMetadataError && (
            <p className="muted" role="status">
              市场描述暂不可用，仍可配置和管理已安装的插件。{market.installedMetadataError}
            </p>
          )}
          <div className="marketplace-card-grid">
            {market.installedEntries.map(({ entry, installed, removable, removeDisabled }) => card(entry, installed, removable, removeDisabled))}
          </div>
          {!market.installedEntries.length && (
            <EmptyState
              title="还没有安装插件"
              description="到发现资源中选择插件，查看详情后安装。"
            />
          )}
        </TabsContent>
      </Tabs>
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
