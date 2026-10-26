import {
  Download,
  ArrowUpCircle,
  Settings2,
  Trash2,
  Puzzle,
  Wrench,
  SlidersHorizontal,
  Package,
} from 'lucide-react';
import { Button, Badge } from '../../../../components/index.ts';
import type { MarketplaceEntry, MarketplaceKind } from '../../../../features/marketplace/index.ts';
import type { PackageInfo } from '../../../../services/api/index.ts';
import { isReleaseEntry, isLegacyCleanupWarning, installationRequiresRecovery, type InstallationClientState, type PluginInstallation } from '../../../../features/plugin-installations/index.ts';
import {
  categoryLabels,
  kindLabels,
  mcpLabels,
  newerVersion,
  installBlock,
} from '../../presentation.ts';

const kindIcons: Record<MarketplaceKind, typeof Puzzle> = {
  plugin: Puzzle,
  tool: Wrench,
  config: SlidersHorizontal,
  distribution: Package,
  resource: Package,
};

export interface MarketplaceCardProps {
  entry: MarketplaceEntry;
  installed?: Pick<PackageInfo, 'version'> | undefined;
  removable?: boolean;
  removeDisabled?: boolean;
  cleanupWarning?: boolean;
  installedTab?: boolean;
  installation?: PluginInstallation | undefined;
  clientState?: InstallationClientState | undefined;
  onSetEnabled?: ((enabled: boolean) => void) | undefined;
  onRetryBrowser?: (() => void) | undefined;
  onDependencies?: (() => void) | undefined;
  busy: boolean;
  onDetail(): void;
  onDownload(): void;
  onInstall(): void;
  onRemove(): void;
  onConfigure(): void;
}

// 卡片只承担扫读：类型、标识与版本、一句话用途、分类与能力标签、来源和一次动作。
// 长标识交给 truncate，不靠改数据长度回避溢出。
export function MarketplaceCard({
  entry,
  installed,
  installedTab = false,
  removable = true,
  removeDisabled = false,
  cleanupWarning: serverCleanupWarning = false,
  installation,
  clientState,
  onSetEnabled,
  onRetryBrowser,
  onDependencies,
  busy,
  onDetail,
  onDownload,
  onInstall,
  onRemove,
  onConfigure,
}: MarketplaceCardProps) {
  const Icon = kindIcons[entry.kind];
  const update = installed ? newerVersion(entry.version, installed.version) : false;
  const blocked = installBlock(entry);
  const recoveryBlocked = installationRequiresRecovery(installation);
  const cleanupWarning = serverCleanupWarning || isLegacyCleanupWarning(installation);
  return (
    <article className="marketplace-card flex min-h-44 flex-col gap-2 rounded-xl border border-[color:var(--hairline)] bg-[color:var(--card)] p-3.5">
      <div className="flex items-start gap-2.5">
        <span
          aria-hidden="true"
          className="grid size-7 shrink-0 place-items-center rounded-lg bg-[color:var(--accent)] text-[color:var(--primary)]"
        >
          <Icon className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={onDetail}
            aria-label={`查看 ${entry.name} 详情`}
            className="block w-full truncate text-left text-[14px] font-medium text-[color:var(--text-strong)] hover:underline"
          >
            {entry.name}
          </button>
          <p className="truncate font-mono text-[12px] text-[color:var(--text-ghost)]" title={entry.id}>
            {entry.id} · v{entry.version || '未知'}
          </p>
        </div>
      </div>

      <p className="line-clamp-2 text-[13px] leading-[1.55] text-[color:var(--text-muted)]">
        {entry.metadataIssues?.length ? '元数据不完整，暂不可安装' : entry.summary || '暂无简介'}
      </p>

      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline">{kindLabels[entry.kind]}</Badge>
        {update && <Badge variant="warning">可更新</Badge>}
        {entry.categories.slice(0, 2).map((value) => (
          <Badge key={value}>{categoryLabels[value] ?? value}</Badge>
        ))}
        {entry.supports_mcp !== 'none' && <Badge variant="info">{mcpLabels[entry.supports_mcp]}</Badge>}
        {entry.supports_agent && <Badge variant="violet">Agent</Badge>}
        {installation && <Badge variant={recoveryBlocked || installation.status === 'configuration_required' || installation.status === 'dependencies_required' ? 'warning' : 'outline'}>
          {recoveryBlocked ? '恢复受阻' : installation.status === 'dependencies_required' ? '依赖未就绪' : installation.status === 'configuration_required' ? '需要配置' : installation.enabled ? '已启用' : '已停用'}
        </Badge>}
      </div>

      {recoveryBlocked && <p role="alert">安装恢复受阻，请查看服务器恢复日志，完成恢复后刷新目录。</p>}
      {cleanupWarning && <p role="status">上次组件操作告警，可重试：{installation?.failure?.reason || '资源回收未确认'}。</p>}
      {clientState?.phase === 'failed' && <p role="alert">本客户端：{clientState.message || '浏览器组件启动失败'}
        {clientState.logId && <> · 日志 ID：<code>{clientState.logId}</code></>}
      </p>}

      <div className="mt-auto flex items-center gap-1.5 border-t border-[color:var(--hairline)] pt-2.5">
        <span
          className="min-w-0 flex-1 truncate text-[12px] text-[color:var(--text-faint)]"
          title={entry.author || entry.sourceName}
        >
          {entry.author || entry.sourceName}
          {entry.applies_to.length > 0 && ` · ${entry.applies_to.join(' / ')}`}
        </span>
        {onDependencies && <Button variant="outline" size="sm" onClick={onDependencies}>依赖</Button>}
        {installedTab ? (
          <>
            {installation && onSetEnabled && <Button variant="outline" size="sm"
              disabled={busy || (recoveryBlocked && !installation.enabled)} onClick={() => onSetEnabled(!installation.enabled)}>
              {installation.enabled ? '停用' : '启用'}
            </Button>}
            {installation?.enabled && (installation.status === 'enabled' || (installation.status === 'recovery_blocked' && !recoveryBlocked)) && clientState?.phase === 'failed' && onRetryBrowser &&
              <Button variant="outline" size="sm" disabled={busy} onClick={onRetryBrowser}>重试本客户端</Button>}
            <Button
              variant="outline"
              size="sm"
              disabled={busy || entry.kind !== 'plugin'}
              title="查看插件声明的配置"
              onClick={onConfigure}
            >
              <Settings2 />
              配置
            </Button>
            <Button variant="ghost" size="sm" disabled={busy || removeDisabled} onClick={onRemove}>
              <Trash2 />
              {removable ? '卸载' : '停用'}
            </Button>
            {update && (
              <Button size="sm" disabled={busy || !!blocked || recoveryBlocked} title={blocked ?? undefined} onClick={onInstall}>
                <ArrowUpCircle />
                更新
              </Button>
            )}
          </>
        ) : (
          <>
            <Button variant="ghost" size="sm" disabled={busy || !entry.resource_id} onClick={onDownload}>
              <Download />
              {isReleaseEntry(entry) ? '下载发布清单' : '下载'}
            </Button>
            {entry.kind === 'plugin' && (
              <Button
                variant={installed && !update ? 'ghost' : 'outline'}
                size="sm"
                disabled={busy || !!blocked || recoveryBlocked || (!!installed && !update)}
                title={blocked ?? undefined}
                onClick={onInstall}
              >
                {update ? <ArrowUpCircle /> : <Download />}
                {installed ? (update ? '更新' : '已安装') : '安装'}
              </Button>
            )}
          </>
        )}
      </div>
    </article>
  );
}
