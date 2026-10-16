import { Download, ArrowUpCircle } from 'lucide-react';
import { Badge, Button, DialogShell } from '../../../../components/index.ts';
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
    <DialogShell
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={entry.name}
      description={entry.summary || '条目详情'}
      size="lg"
      className="marketplace-detail-dialog"
      footer={
        <>
          <Button variant="outline" disabled={busy || !entry.resource_id} onClick={onDownload}>
            <Download />
            下载
          </Button>
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
        </>
      }
    >
      <div className="marketplace-detail-body">
        <div className="marketplace-tags">
          <Badge>{kindLabels[entry.kind]}</Badge>
          <Badge variant="outline">v{entry.version}</Badge>
          {entry.categories.map((category) => (
            <Badge variant="secondary" key={category}>
              {categoryLabels[category] ?? category}
            </Badge>
          ))}
        </div>
        {entry.metadataIssues?.length ? (
          <div className="marketplace-warning" role="status">
            <strong>元数据不完整，暂不可安装</strong>
            <p>{entry.metadataIssues.join('；')}</p>
          </div>
        ) : null}
        <p className="marketplace-description">{entry.description || '作者暂未提供完整描述。'}</p>
        <dl>
          <dt>来源市场</dt>
          <dd>{entry.source || entry.sourceName}</dd>
          <dt>条目标识</dt>
          <dd className="mono">{entry.id}</dd>
          <dt>SHA-256</dt>
          <dd className="mono">{entry.resource_id || '未提供'}</dd>
          <dt>平台 / 架构</dt>
          <dd>
            {entry.platforms.join('、') || '未声明'} / {entry.architectures.join('、') || '未声明'}
          </dd>
          <dt>适用范围</dt>
          <dd>{entry.applies_to.join('、') || '未声明'}</dd>
          <dt>权限要求</dt>
          <dd>{describeDetail(entry.details['permissions'])}</dd>
          <dt>应用方式</dt>
          <dd>{restartLabels[entry.restart_policy]}</dd>
          <dt>调用支持</dt>
          <dd>
            {mcpLabels[entry.supports_mcp]} · {entry.supports_agent ? '支持 Agent' : '不支持 Agent'}
          </dd>
          <dt>作者 / 许可证</dt>
          <dd>
            {entry.author || '未声明'} / {entry.license || '未声明'}
          </dd>
          {installed && (
            <>
              <dt>已安装版本</dt>
              <dd>{installed.version}</dd>
            </>
          )}
        </dl>
        {Object.keys(entry.details).length > 0 && (
          <section>
            <h3>专属信息</h3>
            <dl>
              {Object.entries(entry.details).map(([key, value]) => (
                <div className="marketplace-detail-row" key={key}>
                  <dt>{detailLabels[key] ?? key}</dt>
                  <dd>{describeDetail(value)}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}
        <div className="marketplace-tags">
          {entry.keywords.map((word) => (
            <Badge key={word} variant="outline">
              {word}
            </Badge>
          ))}
        </div>
      </div>
    </DialogShell>
  );
}
