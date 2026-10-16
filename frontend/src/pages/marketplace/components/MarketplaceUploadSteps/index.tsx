import type { MarketplaceUploadDraft } from '../../upload.ts';
import { splitMetadataList } from '../../upload.ts';
import { Stepper } from '../../../../components/index.ts';

export type MarketplaceUploadStep = 1 | 2 | 3;

const kindLabels: Record<MarketplaceUploadDraft['kind'], string> = {
  plugin: '插件',
  tool: '工具',
  config: '配置',
  distribution: '分发包',
  resource: '内部资源',
};

const mcpLabels: Record<MarketplaceUploadDraft['supportsMcp'], string> = {
  none: '不支持',
  client: '客户端',
  server: '服务端',
  both: '双向',
};

const restartLabels: Record<MarketplaceUploadDraft['restartPolicy'], string> = {
  none: '无需重启',
  browser_refresh: '刷新浏览器',
  plugin_reload: '重载插件',
  service_restart: '重启服务',
  device_restart: '重启设备',
};

export function MarketplaceUploadSteps({ current }: { current: MarketplaceUploadStep }) {
  return <Stepper label="上传发布步骤" currentStep={current - 1} steps={[
    { id: 'file', title: '选择资源', description: '文件与发布类型' },
    { id: 'metadata', title: '填写描述', description: '基本信息与兼容性' },
    { id: 'review', title: '确认发布', description: '检查并上传' },
  ]} />;
}

export function MarketplaceUploadReviewStep({
  draft,
  file,
}: {
  draft: MarketplaceUploadDraft;
  file: File | null;
}) {
  return (
    <section className="marketplace-upload-review" aria-label="发布确认">
      <div className="marketplace-upload-review-heading">
        <div>
          <h3>确认发布内容</h3>
          <p className="muted">确认后会先上传原始文件，再使用返回的 SHA-256 发布市场条目。</p>
        </div>
        <span className="marketplace-upload-review-kind">{kindLabels[draft.kind]}</span>
      </div>
      <dl>
        <dt>文件</dt>
        <dd>{file ? `${file.name}（${file.size} 字节）` : '未选择'}</dd>
        <dt>标识 / 版本</dt>
        <dd className="mono">
          {draft.id || '未填写'} / {draft.version || '未填写'}
        </dd>
        <dt>名称</dt>
        <dd>{draft.name || '未填写'}</dd>
        <dt>简介</dt>
        <dd>{draft.summary || '未填写'}</dd>
        <dt>分类</dt>
        <dd>{joinList(draft.categories)}</dd>
        <dt>适用项目</dt>
        <dd>{joinList(draft.appliesTo)}</dd>
        <dt>兼容性</dt>
        <dd>
          {joinList(draft.platforms)} / {joinList(draft.architectures)}
        </dd>
        <dt>MCP / Agent</dt>
        <dd>
          {mcpLabels[draft.supportsMcp]} / {draft.supportsAgent ? '支持' : '不支持'}
        </dd>
        <dt>应用后</dt>
        <dd>{restartLabels[draft.restartPolicy]}</dd>
        <dt>可见性</dt>
        <dd>{draft.visibility === 'internal' ? '内部资源' : '市场展示'}</dd>
      </dl>
      <div className="marketplace-upload-review-details">
        <span>类型专属描述</span>
        <pre>{draft.details || '{}'}</pre>
      </div>
    </section>
  );
}

function joinList(value: string): string {
  const items = splitMetadataList(value);
  return items.length > 0 ? items.join('、') : '未填写';
}
