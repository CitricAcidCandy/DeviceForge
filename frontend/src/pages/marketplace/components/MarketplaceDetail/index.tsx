import { Download, ArrowUpCircle } from 'lucide-react';
import {
  Badge,
  Button,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '../../../../components/index.ts';
import type { MarketplaceEntry } from '../../../../features/marketplace/index.ts';
import type { PackageInfo } from '../../../../services/api/index.ts';
import {
  categoryLabels,
  describeDetail,
  installBlock,
  kindLabels,
  mcpLabels,
  newerVersion,
  restartLabels,
} from '../../presentation.ts';

const detailLabels: Record<string, string> = {
  tool_type: '工具类型',
  commands: '命令与能力',
  capabilities: '提供能力',
  dependencies: '外部依赖',
  requires_root: '需要 Root',
  requires_admin: '需要管理员权限',
  requires_device: '需要设备连接',
  config_type: '配置对象类型',
  schema_version: 'Schema 版本',
  targets: '适用工具或插件',
  supports_rollback: '支持版本回退',
  contains_local_paths: '包含本地路径',
  contains_secrets: '包含敏感字段',
  package_name: 'npx 包名',
  entrypoint: '可执行入口',
  host_version: '宿主版本',
  runtime_resources: '运行时资源',
  plugin_kind: '插件运行位置',
  permissions: '权限要求',
  configuration: '配置入口',
};

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-3 border-b border-[color:var(--hairline)] py-2 last:border-b-0">
      <dt className="w-22 shrink-0 text-[12px] leading-5 text-[color:var(--text-faint)]">{label}</dt>
      <dd
        className={
          mono
            ? 'min-w-0 flex-1 break-all font-mono text-[12px] leading-5 text-[color:var(--text-body)]'
            : 'min-w-0 flex-1 text-[13px] leading-5 text-[color:var(--text-body)]'
        }
      >
        {value}
      </dd>
    </div>
  );
}

// 详情从居中弹层改成右侧抽屉：开着详情仍能对着列表比对，不打断当前位置。
export function MarketplaceDetail({
  entry,
  installed,
  busy,
  onClose,
  onDownload,
  onInstall,
}: {
  entry: MarketplaceEntry | null;
  installed: Pick<PackageInfo, 'version'> | undefined;
  busy: boolean;
  onClose(): void;
  onDownload(): void;
  onInstall(): void;
}) {
  if (!entry) return null;
  const update = installed && newerVersion(entry.version, installed.version);
  const blocked = installBlock(entry);
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        side="right"
        className="w-full gap-0 border-l border-[color:var(--hairline)] bg-[color:var(--card)] p-0 sm:max-w-105"
      >
        <SheetHeader className="gap-2 border-b border-[color:var(--hairline)] p-5 pr-12">
          <div className="flex flex-wrap items-baseline gap-2">
            <SheetTitle className="text-[18px] leading-6 text-[color:var(--text-strong)]">
              {entry.name}
            </SheetTitle>
            <span className="font-mono text-[12px] text-[color:var(--text-ghost)]">
              {entry.id} · v{entry.version}
            </span>
          </div>
          <SheetDescription className="text-[12px] text-[color:var(--text-faint)]">
            {entry.author || entry.sourceName} · {entry.license || '许可未声明'} ·{' '}
            {entry.applies_to.join(' / ') || '适用范围未声明'}
          </SheetDescription>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline">{kindLabels[entry.kind]}</Badge>
            {update && <Badge variant="warning">可更新至 v{entry.version}</Badge>}
            {entry.supports_mcp !== 'none' && <Badge variant="info">{mcpLabels[entry.supports_mcp]}</Badge>}
            {entry.supports_agent && <Badge variant="violet">支持 Agent</Badge>}
          </div>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-5 py-4">
          {entry.metadataIssues?.length ? (
            <div
              className="rounded-lg border border-[color:var(--warning)]/40 bg-[color:var(--warning)]/8 px-3 py-2 text-[13px] text-[color:var(--text-body)]"
              role="status"
            >
              <strong className="block text-[color:var(--warning)]">元数据不完整，暂不可安装</strong>
              <p className="text-[12px] text-[color:var(--text-muted)]">{entry.metadataIssues.join('；')}</p>
            </div>
          ) : null}

          <p className="text-[13px] leading-[1.75] text-[color:var(--text-body)]">
            {entry.description || entry.summary || '作者暂未提供完整描述。'}
          </p>

          <dl className="flex flex-col">
            <Row label="来源市场" value={entry.source || entry.sourceName} />
            <Row label="SHA-256" value={entry.resource_id || '未提供'} mono />
            <Row
              label="平台 / 架构"
              value={`${entry.platforms.join('、') || '未声明'} / ${entry.architectures.join('、') || '未声明'}`}
            />
            <Row label="适用范围" value={entry.applies_to.join('、') || '未声明'} />
            <Row label="分类" value={entry.categories.map((item) => categoryLabels[item] ?? item).join('、') || '未声明'} />
            <Row label="权限要求" value={describeDetail(entry.details['permissions'])} />
            <Row label="应用方式" value={restartLabels[entry.restart_policy]} />
            <Row
              label="调用支持"
              value={`${mcpLabels[entry.supports_mcp]} · ${entry.supports_agent ? '支持 Agent' : '不支持 Agent'}`}
            />
            <Row label="作者 / 许可证" value={`${entry.author || '未声明'} / ${entry.license || '未声明'}`} />
            {installed && <Row label="已安装版本" value={installed.version} mono />}
          </dl>

          {Object.keys(entry.details).length > 0 && (
            <section className="flex flex-col gap-1">
              <h3 className="text-[12px] font-medium text-[color:var(--text-muted)]">专属信息</h3>
              <dl className="flex flex-col">
                {Object.entries(entry.details).map(([key, value]) => (
                  <Row key={key} label={detailLabels[key] ?? key} value={describeDetail(value)} />
                ))}
              </dl>
            </section>
          )}

          {entry.keywords.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {entry.keywords.map((word) => (
                <Badge key={word} variant="outline">
                  {word}
                </Badge>
              ))}
            </div>
          )}
        </div>

        <SheetFooter className="flex-row items-center gap-2 border-t border-[color:var(--hairline)] p-4">
          <Button variant="outline" disabled={busy || !entry.resource_id} onClick={onDownload}>
            <Download />
            下载
          </Button>
          <div className="flex-1" />
          {entry.kind === 'plugin' && (
            <Button
              disabled={busy || !!blocked || (!!installed && !update)}
              title={blocked ?? undefined}
              onClick={onInstall}
            >
              {update ? <ArrowUpCircle /> : <Download />}
              {update ? '更新' : installed ? '已安装' : '安装'}
            </Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
