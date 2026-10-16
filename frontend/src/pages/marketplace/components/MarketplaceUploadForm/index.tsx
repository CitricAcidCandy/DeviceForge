import { Input } from '../../../../components/Input/index.tsx';
import { Checkbox } from '../../../../components/Checkbox/index.tsx';
import { Textarea } from '../../../../components/Textarea/index.tsx';
import { FormGrid, FormRow, FileDropzone, SelectField, FormSection } from '../../../../components/index.ts';
import { marketplaceCategories } from '../../../../features/marketplace/index.ts';
import type {
  MarketplaceKind,
  MarketplaceMcp,
  MarketplaceRestart,
} from '../../../../features/marketplace/index.ts';
import type { MarketplaceUploadDraft } from '../../upload.ts';

const kindOptions: readonly [MarketplaceKind, string][] = [
  ['plugin', '插件'],
  ['tool', '工具'],
  ['config', '配置'],
  ['distribution', '分发包'],
  ['resource', '内部资源'],
];
const mcpOptions: readonly [MarketplaceMcp, string][] = [
  ['none', '不支持'],
  ['client', '客户端'],
  ['server', '服务端'],
  ['both', '双向'],
];
const restartOptions: readonly [MarketplaceRestart, string][] = [
  ['none', '无需重启'],
  ['browser_refresh', '刷新浏览器'],
  ['plugin_reload', '重载插件'],
  ['service_restart', '重启服务'],
  ['device_restart', '重启设备'],
];

export type MarketplaceUploadFormStep = 1 | 2;

export interface MarketplaceUploadFormProps {
  readonly step: MarketplaceUploadFormStep;
  readonly draft: MarketplaceUploadDraft;
  readonly file: File | null;
  readonly disabled: boolean;
  readonly onFileChange: (file: File | null) => void;
  readonly onDraftChange: <K extends keyof MarketplaceUploadDraft>(
    key: K,
    value: MarketplaceUploadDraft[K],
  ) => void;
}

export function MarketplaceUploadForm({
  step,
  draft,
  file,
  disabled,
  onFileChange,
  onDraftChange,
}: MarketplaceUploadFormProps) {
  if (step === 1) {
    return (
      <div className="marketplace-upload-form">
        <FormGrid>
          <FileDropzone label="资源文件" description="选择或拖入插件包、工具、配置，或图片与视频资源" file={file} disabled={disabled} onFileChange={onFileChange} />
          <FormRow label="类型">
            {(control) => (
              <SelectField
                {...control}
                value={draft.kind}
                disabled={disabled}
                options={kindOptions.map(([value, label]) => ({value, label}))}
                onValueChange={(value) => {
                  const nextKind = kindOptions.find(([kind]) => kind === value)?.[0];
                  if (!nextKind) return;
                  onDraftChange('kind', nextKind);
                  onDraftChange('categories', marketplaceCategories[nextKind][0] ?? 'general');
                  onDraftChange('visibility', nextKind === 'resource' ? 'internal' : 'market');
                  onDraftChange('details', JSON.stringify(nextKind === 'plugin' ? { plugin_kind: 'browser' } : nextKind === 'tool' ? { tool_type: 'utility' } : nextKind === 'config' ? { config_type: 'preset', schema_version: 1 } : nextKind === 'distribution' ? { package_name: '', entrypoint: '' } : {}, null, 2));
                }}
              />
            )}
          </FormRow>
          <FormRow label="可见性" hint="资源类型只能作为内部资源保存">
            {(control) => (
              <SelectField
                {...control}
                value={draft.visibility}
                disabled={disabled || draft.kind === 'resource'}
                options={[{value:'market',label:'市场展示'}, {value:'internal',label:'内部资源'}]}
                onValueChange={(value) =>
                  onDraftChange('visibility', value === 'internal' ? 'internal' : 'market')
                }
              />
            )}
          </FormRow>
        </FormGrid>
        {file && (
          <p className="muted">
            已选择：{file.name}（{file.size} 字节）
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="marketplace-upload-form">
      <FormSection title="基本信息与检索"><FormGrid>
        <FormRow label="条目标识 *" hint="小写字母、数字、下划线或连字符">
          {(control) => (
            <Input
              {...control}
              value={draft.id}
              disabled={disabled}
              onChange={(event) => onDraftChange('id', event.target.value)}
            />
          )}
        </FormRow>
        <FormRow label="名称 *">
          {(control) => (
            <Input
              {...control}
              value={draft.name}
              disabled={disabled}
              onChange={(event) => onDraftChange('name', event.target.value)}
            />
          )}
        </FormRow>
        <FormRow label="版本 *">
          {(control) => (
            <Input
              {...control}
              value={draft.version}
              disabled={disabled}
              onChange={(event) => onDraftChange('version', event.target.value)}
            />
          )}
        </FormRow>
        <FormRow label="简介 *">
          {(control) => (
            <Input
              {...control}
              value={draft.summary}
              disabled={disabled}
              onChange={(event) => onDraftChange('summary', event.target.value)}
            />
          )}
        </FormRow>
        <FormRow label="分类" hint="用逗号分隔，例如 function,ui">
          {(control) => (
            <Input
              {...control}
              value={draft.categories}
              disabled={disabled}
              onChange={(event) => onDraftChange('categories', event.target.value)}
            />
          )}
        </FormRow>
        <FormRow label="适用项目" hint="用逗号分隔，例如 deviceforge,universal">
          {(control) => (
            <Input
              {...control}
              value={draft.appliesTo}
              disabled={disabled}
              onChange={(event) => onDraftChange('appliesTo', event.target.value)}
            />
          )}
        </FormRow>
      </FormGrid>
      <FormRow label="完整描述">
        {(control) => (
          <Textarea
            {...control}
            value={draft.description}
            disabled={disabled}
            onChange={(event) => onDraftChange('description', event.target.value)}
            rows={3}
          />
        )}
      </FormRow></FormSection>
      <FormSection title="兼容性与调用能力"><FormGrid>
        <FormRow label="关键词" hint="用逗号分隔">
          {(control) => (
            <Input
              {...control}
              value={draft.keywords}
              disabled={disabled}
              onChange={(event) => onDraftChange('keywords', event.target.value)}
            />
          )}
        </FormRow>
        <FormRow label="平台 / 架构" hint="分别用逗号分隔">
          {() => (
            <div className="inline-action">
              <Input
                aria-label="支持平台"
                value={draft.platforms}
                disabled={disabled}
                onChange={(event) => onDraftChange('platforms', event.target.value)}
              />
              <Input
                aria-label="支持架构"
                value={draft.architectures}
                disabled={disabled}
                onChange={(event) => onDraftChange('architectures', event.target.value)}
              />
            </div>
          )}
        </FormRow>
        <FormRow label="MCP / 应用后">
          {() => (
            <div className="inline-action">
              <SelectField
                aria-label="MCP 支持"
                value={draft.supportsMcp}
                disabled={disabled}
                options={mcpOptions.map(([value, label]) => ({value,label}))}
                onValueChange={(value) => { const selected = mcpOptions.find(([key]) => key === value); if (selected) onDraftChange('supportsMcp', selected[0]); }}
              />
              <SelectField
                aria-label="重启策略"
                value={draft.restartPolicy}
                disabled={disabled}
                options={restartOptions.map(([value,label]) => ({value,label}))}
                onValueChange={(value) => { const selected = restartOptions.find(([key]) => key === value); if (selected) onDraftChange('restartPolicy', selected[0]); }}
              />
            </div>
          )}
        </FormRow>
        <FormRow label="作者 / 许可证">
          {() => (
            <div className="inline-action">
              <Input
                aria-label="作者"
                value={draft.author}
                disabled={disabled}
                onChange={(event) => onDraftChange('author', event.target.value)}
              />
              <Input
                aria-label="许可证"
                value={draft.license}
                disabled={disabled}
                onChange={(event) => onDraftChange('license', event.target.value)}
              />
            </div>
          )}
        </FormRow>
      </FormGrid>
      <div className="marketplace-upload-check">
        <Checkbox
          id="marketplace-supports-agent"
          checked={draft.supportsAgent}
          disabled={disabled}
          onCheckedChange={(checked) => onDraftChange('supportsAgent', checked === true)}
        />
        <label htmlFor="marketplace-supports-agent">支持内置 Agent 调用</label>
      </div></FormSection>
      <FormRow label="类型专属描述" hint="工具、配置、分发包需填写契约要求的 JSON 字段">
        {(control) => (
          <Textarea
            {...control}
            value={draft.details}
            disabled={disabled}
            onChange={(event) => onDraftChange('details', event.target.value)}
            rows={4}
          />
        )}
      </FormRow>
    </div>
  );
}
