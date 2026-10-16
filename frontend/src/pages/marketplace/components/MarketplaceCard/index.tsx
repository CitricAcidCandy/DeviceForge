import { Download, ArrowUpCircle, Settings2, Trash2, Puzzle, Wrench, SlidersHorizontal, Package, Check } from 'lucide-react';
import { Button, Card, Badge } from '../../../../components/index.ts';
import type { MarketplaceEntry } from '../../../../features/marketplace/index.ts';
import type { PackageInfo } from '../../../../services/api/index.ts';
import { categoryLabels, kindLabels, newerVersion, configurationTarget } from '../../presentation.ts';

export interface MarketplaceCardProps {
  entry: MarketplaceEntry; installed?: PackageInfo | undefined; installedTab?: boolean;
  busy: boolean; onDetail(): void; onDownload(): void; onInstall(): void; onRemove(): void; onConfigure(): void;
}
export function MarketplaceCard({ entry, installed, installedTab = false, busy, onDetail, onDownload, onInstall, onRemove, onConfigure }: MarketplaceCardProps) {
  const Icon = { plugin: Puzzle, tool: Wrench, config: SlidersHorizontal, distribution: Package, resource: Package }[entry.kind];
  const update = installed && newerVersion(entry.version, installed.version);
  return <Card className={`marketplace-card marketplace-kind-${entry.kind}`}>
    <div className="marketplace-card-heading"><span className="marketplace-kind-icon"><Icon /></span><Badge variant="outline">{kindLabels[entry.kind]}</Badge>{installed && <Badge variant="success"><Check />已安装</Badge>}</div>
    <button className="marketplace-card-content" type="button" onClick={onDetail} aria-label={`查看 ${entry.name} 详情`}>
      <h3>{entry.name}</h3><span className="marketplace-version">v{entry.version || '未知'}</span><p>{entry.summary || '暂无简介'}</p>
    </button>
    <div className="marketplace-tags">{entry.categories.slice(0, 3).map((value) => <Badge key={value} variant="secondary">{categoryLabels[value] ?? value}</Badge>)}{entry.supports_mcp !== 'none' && <Badge variant="info">MCP</Badge>}{entry.supports_agent && <Badge variant="violet">Agent</Badge>}</div>
    {entry.metadataIssues?.length ? <p className="marketplace-incomplete">元数据不完整</p> : <p className="marketplace-card-source" title={entry.source}>{entry.author || entry.sourceName} · {entry.applies_to.join(' / ')}</p>}
    <div className="marketplace-card-actions">
      {installedTab ? <>
        <Button variant="outline" disabled={busy || !configurationTarget(entry)} title={configurationTarget(entry) ? '编辑插件声明的配置区' : '插件未声明配置入口'} onClick={onConfigure}><Settings2 />配置</Button>
        <Button variant="ghost" disabled={busy} onClick={onRemove}><Trash2 />卸载</Button>
        {update && <Button disabled={busy} onClick={onInstall}><ArrowUpCircle />更新</Button>}
      </> : <>
        <Button variant="outline" disabled={busy || !entry.resource_id} onClick={onDownload}><Download />下载</Button>
        {entry.kind === 'plugin' && <Button disabled={busy || !!entry.metadataIssues?.length || (!!installed && !update)} onClick={onInstall}>{update ? <ArrowUpCircle /> : <Download />}{installed ? update ? '更新' : '已安装' : '安装'}</Button>}
      </>}
    </div>
  </Card>;
}
