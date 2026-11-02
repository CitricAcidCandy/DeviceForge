import type { MarketplaceUploadDraft } from '../../upload.ts';
import { splitMetadataList } from '../../upload.ts';
import { Stepper } from '../../ui.tsx';
import type { UploadInspection } from '../../upload-preparation/index.ts';

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
  return (
    <Stepper
      label="上传发布步骤"
      currentStep={current - 1}
      steps={[
        { id: 'file', title: '选择资源', description: '文件与发布类型' },
        { id: 'metadata', title: '填写描述', description: '基本信息与兼容性' },
        { id: 'review', title: '确认发布', description: '检查并上传' },
      ]}
    />
  );
}

export function MarketplaceUploadReviewStep({
  draft,
  file,
  inspection,
  sha256,
}: {
  draft: MarketplaceUploadDraft;
  file: File | null;
  inspection?: UploadInspection | null;
  sha256?: string | null;
}) {
  return (
    <section className="grid gap-4 [&_dl]:m-0 [&_dl]:grid [&_dl]:grid-cols-[7rem_minmax(0,1fr)] [&_dl]:gap-x-3 [&_dl]:gap-y-2 [&_dt]:text-muted-foreground [&_dd]:m-0 [&_dd]:min-w-0 [&_dd]:[overflow-wrap:anywhere] max-[900px]:[&_dl]:grid-cols-[6rem_minmax(0,1fr)]" aria-label="发布确认">
      <div className="flex items-start justify-between gap-4 [&_h3]:m-0">
        <div>
          <h3>确认发布内容</h3>
          <p className="text-sm text-muted-foreground">市场描述已同步至待发布归档。确认后上传最终文件并核对 SHA-256。</p>
        </div>
        <span className="shrink-0 rounded-full border px-2.5 py-1 text-[13px] text-muted-foreground">{kindLabels[draft.kind]}</span>
      </div>
      <dl>
        <dt>文件</dt>
        <dd>{file ? `${file.name}（${file.size} 字节）` : '未选择'}</dd>
        <dt>标识 / 版本</dt>
        <dd className="font-mono">
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
      {sha256 && <p className="font-mono text-[13px] [overflow-wrap:anywhere]">SHA-256：{sha256}</p>}
      {inspection && <details open><summary>文件树（{inspection.files.length} 项，展开 {inspection.totalSize} 字节）</summary><ul className="max-h-64 overflow-auto rounded-lg bg-muted p-3 [&_li]:flex [&_li]:min-w-0 [&_li]:justify-between [&_li]:gap-4 [&_li]:text-[13px] [&_code]:[overflow-wrap:anywhere] [&_span]:shrink-0">{inspection.files.map(item => <li key={item.path}><code>{item.path}</code><span>{item.size} 字节</span></li>)}</ul></details>}
      {inspection && inspection.excluded.length > 0 && <details><summary>已排除 {inspection.excluded.length} 项</summary><ul className="max-h-64 overflow-auto rounded-lg bg-muted p-3 [&_li]:flex [&_li]:min-w-0 [&_li]:justify-between [&_li]:gap-4 [&_li]:text-[13px] [&_code]:[overflow-wrap:anywhere] [&_span]:shrink-0">{inspection.excluded.map(path => <li key={path}>{path}</li>)}</ul></details>}
      <div className="grid gap-2 [&_span]:text-sm [&_span]:text-muted-foreground [&_pre]:m-0 [&_pre]:max-h-32 [&_pre]:overflow-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:bg-muted [&_pre]:p-3 [&_pre]:whitespace-pre-wrap [&_pre]:[overflow-wrap:anywhere]">
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
