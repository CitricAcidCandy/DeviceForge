import { Checkbox, FormGrid, FormRow, FormSection, Input, SelectField, Textarea } from '../../../../components/index.ts';
import type { MarketplaceUploadDraft } from '../../upload.ts';

export function ReleasePublicationMetadata({ draft, disabled, onChange }: {
  readonly draft: MarketplaceUploadDraft;
  readonly disabled: boolean;
  readonly onChange: <K extends keyof MarketplaceUploadDraft>(key: K, value: MarketplaceUploadDraft[K]) => void;
}) {
  return (
    <FormSection title="市场展示资料" className="grid gap-3">
      <FormRow label="市场简介" required hint="用于市场卡片，可与清单中的完整描述不同。">
        {(control) => <Textarea {...control} rows={2} value={draft.summary} disabled={disabled}
          onChange={(event) => onChange('summary', event.target.value)} />}
      </FormRow>
      <FormGrid>
        <FormRow label="分类">
          {(control) => <SelectField {...control} value={draft.categories} disabled={disabled}
            options={[{ value: 'function', label: '功能扩展' }, { value: 'theme', label: '主题' }, { value: 'ui', label: '界面组件' }, { value: 'integration', label: '集成' }]}
            onValueChange={(value) => onChange('categories', value)} />}
        </FormRow>
        <FormRow label="适用项目" hint="多个项目使用逗号分隔">
          {(control) => <Input {...control} value={draft.appliesTo} disabled={disabled} onChange={(event) => onChange('appliesTo', event.target.value)} />}
        </FormRow>
        <FormRow label="作者">
          {(control) => <Input {...control} value={draft.author} disabled={disabled} onChange={(event) => onChange('author', event.target.value)} />}
        </FormRow>
        <FormRow label="许可证">
          {(control) => <Input {...control} value={draft.license} disabled={disabled} onChange={(event) => onChange('license', event.target.value)} />}
        </FormRow>
        <FormRow label="关键词" hint="多个关键词使用逗号分隔">
          {(control) => <Input {...control} value={draft.keywords} disabled={disabled} onChange={(event) => onChange('keywords', event.target.value)} />}
        </FormRow>
        <FormRow label="MCP 支持">
          {(control) => <SelectField {...control} value={draft.supportsMcp} disabled={disabled}
            options={[{ value: 'none', label: '不支持' }, { value: 'client', label: '客户端' }, { value: 'server', label: '服务端' }, { value: 'both', label: '客户端与服务端' }]}
            onValueChange={(value) => { if (value === 'none' || value === 'client' || value === 'server' || value === 'both') onChange('supportsMcp', value); }} />}
        </FormRow>
      </FormGrid>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={draft.supportsAgent} disabled={disabled}
          onCheckedChange={(checked) => onChange('supportsAgent', checked === true)} />
        支持内置 Agent 调用
      </label>
    </FormSection>
  );
}
