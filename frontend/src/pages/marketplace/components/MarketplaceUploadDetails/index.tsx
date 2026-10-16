import { Checkbox, FormGrid, FormRow, FormSection, Input, SelectField, Textarea } from '../../../../components/index.ts';
import type { MarketplaceUploadDraft } from '../../upload.ts';

export function MarketplaceUploadDetails({ draft, disabled, onChange }: { draft: MarketplaceUploadDraft; disabled: boolean; onChange(value: string): void }) {
  let details: Record<string, unknown> = {};
  try { const value: unknown = JSON.parse(draft.details); if (value && typeof value === 'object' && !Array.isArray(value)) details = value as Record<string, unknown>; } catch { /* 高级编辑尚未完成时保留原文。 */ }
  const change = (key: string, value: unknown) => onChange(JSON.stringify({ ...details, [key]: value }, null, 2));
  const text = (key: string, label: string, list = false) => <FormRow key={key} label={label}>{control => <Input {...control} disabled={disabled} value={list && Array.isArray(details[key]) ? details[key].join(',') : typeof details[key] === 'string' || typeof details[key] === 'number' ? String(details[key]) : ''}
    onChange={event => change(key, list ? event.target.value.split(/[,，]/).map(item => item.trim()).filter(Boolean) : event.target.value)} />}</FormRow>;
  const check = (key: string, label: string) => <label key={key} className="marketplace-upload-check"><Checkbox disabled={disabled} checked={details[key] === true} onCheckedChange={value => change(key, value === true)} />{label}</label>;
  return <FormSection title="类型专属信息"><FormGrid>
    {draft.kind === 'plugin' && <FormRow label="插件运行位置">{control => <SelectField {...control} disabled={disabled} value={typeof details.plugin_kind === 'string' ? details.plugin_kind : 'browser'} options={[{ value: 'server', label: '服务器插件' }, { value: 'browser', label: '浏览器插件' }]} onValueChange={value => change('plugin_kind', value)} />}</FormRow>}
    {draft.kind === 'tool' && <>{text('tool_type', '工具类型')}{text('capabilities', '提供的能力（逗号分隔）', true)}{text('commands', '提供的命令（逗号分隔）', true)}{text('external_dependencies', '外部依赖（逗号分隔）', true)}{check('requires_root', '需要 Root')}{check('requires_admin', '需要管理员权限')}{check('requires_device', '需要连接设备')}</>}
    {draft.kind === 'config' && <>{text('config_type', '配置对象类型')}<FormRow label="Schema 版本">{control => <Input {...control} type="number" min={1} disabled={disabled} value={typeof details.schema_version === 'number' ? details.schema_version : 1} onChange={event => change('schema_version', Number(event.target.value))} />}</FormRow>{text('targets', '适用插件或工具（逗号分隔）', true)}{check('supports_rollback', '支持版本回退')}{check('contains_local_paths', '包含本地路径')}{check('contains_sensitive_fields', '包含敏感字段')}</>}
    {draft.kind === 'distribution' && <>{text('package_name', 'npx 包名')}{text('entrypoint', '可执行入口')}{text('host_version', '宿主版本')}{text('runtime_sha256', '运行时 SHA-256')}</>}
    {draft.kind === 'resource' && <p className="muted">媒体 MIME、大小和摘要由实际上传内容决定，默认作为内部资源引用。</p>}
    {text('permissions', '权限要求（逗号分隔）', true)}
  </FormGrid><details><summary>高级 JSON 描述</summary><Textarea aria-label="高级类型专属描述" disabled={disabled} rows={5} value={draft.details} onChange={event => onChange(event.target.value)} /></details></FormSection>;
}
