import { useId, useState } from 'react';
import { Button } from '../../ui.tsx';
import { Input } from '../../ui.tsx';
import { Textarea } from '../../ui.tsx';
import { SelectField } from '../../ui.tsx';
import { Checkbox } from '../../ui.tsx';
import { FormRow } from '../../ui.tsx';
import { isSchemaValue, schemaDefault, schemaObject } from '../../schema.ts';
import type { SchemaValue, SchemaIssue } from '../../schema.ts';

export interface SchemaFormProps {
  readonly schema: SchemaValue;
  readonly value: SchemaValue;
  readonly onChange: (value: SchemaValue) => void;
  readonly disabled?: boolean;
  readonly errors?: readonly SchemaIssue[];
}

function SchemaField({ schema, value, onChange, disabled = false, errors = [], path, label, required = false }: SchemaFormProps & {
  path: string; label: string; required?: boolean;
}) {
  const definition = schemaObject(schema);
  const id = useId();
  const [mapKey, setMapKey] = useState('');
  const readonly = disabled || definition['readOnly'] === true;
  const title = typeof definition['title'] === 'string' ? definition['title'] : label;
  const description = typeof definition['description'] === 'string' ? definition['description'] : undefined;
  const error = errors.filter((item) => item.path === path).map((item) => item.message).join('；') || undefined;
  const type = definition['type'];
  const choices = definition['enum'];
  if (Array.isArray(choices)) return <FormRow id={id} label={title} required={required} {...(description ? { hint: description } : {})} {...(error ? { error } : {})}>
    <SelectField id={id} value={String(choices.findIndex((item) => JSON.stringify(item) === JSON.stringify(value)))} disabled={readonly}
      options={choices.map((item, index) => ({ value: String(index), label: typeof item === 'string' ? item : JSON.stringify(item) }))}
      onValueChange={(next) => { const selected = choices[Number(next)]; if (selected !== undefined) onChange(selected); }} />
  </FormRow>;
  if (type === 'object' || definition['properties']) {
    const object = schemaObject(value);
    const properties = schemaObject(definition['properties']);
    const requiredKeys = Array.isArray(definition['required']) ? definition['required'] : [];
    const additional = definition['additionalProperties'];
    const fields = [...Object.keys(properties), ...Object.keys(object).filter((key) => !Object.hasOwn(properties, key))];
    return <fieldset className="m-0 grid min-w-0 gap-4 rounded-xl border p-4 [&>legend]:px-1.5 [&>legend]:font-semibold max-[640px]:p-3" disabled={readonly}><legend>{title}{required ? ' *' : ''}</legend>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
      {fields.map((key) => <div key={key} className="flex min-w-0 items-start gap-3 [&>:first-child]:min-w-0 [&>:first-child]:flex-1"><SchemaField schema={properties[key] ?? (additional && typeof additional === 'object' ? additional : {})}
        value={object[key] ?? schemaDefault(properties[key] ?? {})} label={key} path={`${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`}
        required={requiredKeys.includes(key)} disabled={readonly} errors={errors}
        onChange={(next) => onChange({ ...object, [key]: next })} />
        {!Object.hasOwn(properties, key) && <Button type="button" variant="ghost" disabled={readonly} aria-label={`删除 ${key}`} onClick={() => onChange(Object.fromEntries(Object.entries(object).filter(([name]) => name !== key)))}>删除</Button>}
      </div>)}
      {additional !== false && <div className="flex items-center gap-2 max-[640px]:flex-wrap"><Input aria-label={`${title} 新字段名称`} value={mapKey} disabled={readonly} onChange={(event) => setMapKey(event.target.value)} />
        <Button type="button" variant="outline" disabled={readonly || !mapKey.trim() || Object.hasOwn(object, mapKey.trim()) || ['__proto__', 'constructor', 'prototype'].includes(mapKey.trim())}
          onClick={() => { onChange({ ...object, [mapKey.trim()]: schemaDefault(additional && typeof additional === 'object' ? additional : {}) }); setMapKey(''); }}>添加字段</Button></div>}
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
    </fieldset>;
  }
  if (type === 'array' || Array.isArray(value)) {
    const items = Array.isArray(value) ? value : [];
    const itemSchema = definition['items'] ?? {};
    return <fieldset className="m-0 grid min-w-0 gap-4 rounded-xl border p-4 [&>legend]:px-1.5 [&>legend]:font-semibold max-[640px]:p-3" disabled={readonly}><legend>{title}{required ? ' *' : ''}</legend>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
      {items.map((item, index) => <div className="flex min-w-0 items-start gap-3 [&>:first-child]:min-w-0 [&>:first-child]:flex-1" key={index}><SchemaField schema={itemSchema} value={item} path={`${path}/${index}`} label={`第 ${index + 1} 项`} disabled={readonly} errors={errors}
        onChange={(next) => onChange(items.map((current, position) => position === index ? next : current))} />
        <Button type="button" variant="ghost" disabled={readonly} aria-label={`删除第 ${index + 1} 项`} onClick={() => onChange(items.filter((_, position) => position !== index))}>删除</Button></div>)}
      <Button type="button" variant="outline" disabled={readonly || (typeof definition['maxItems'] === 'number' && items.length >= definition['maxItems'])} onClick={() => onChange([...items, schemaDefault(itemSchema)])}>添加一项</Button>
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
    </fieldset>;
  }
  if (type === 'boolean' || typeof value === 'boolean') return <FormRow id={id} label={title} required={required} {...(description ? { hint: description } : {})} {...(error ? { error } : {})}>
    <Checkbox id={id} checked={value === true} disabled={readonly} onCheckedChange={(checked) => onChange(checked === true)} />
  </FormRow>;
  const numeric = type === 'number' || type === 'integer';
  const secret = definition['writeOnly'] === true || definition['format'] === 'password';
  const text = typeof value === 'string' || typeof value === 'number' ? String(value) : value === null ? '' : JSON.stringify(value);
  return <FormRow id={id} label={title} required={required} {...(description ? { hint: description } : {})} {...(error ? { error } : {})}>
    <Input id={id} type={secret ? 'password' : numeric ? 'number' : 'text'} autoComplete={secret ? 'new-password' : undefined}
      value={text} disabled={readonly} readOnly={definition['readOnly'] === true}
      min={typeof definition['minimum'] === 'number' ? definition['minimum'] : undefined} max={typeof definition['maximum'] === 'number' ? definition['maximum'] : undefined}
      step={type === 'integer' ? 1 : numeric ? 'any' : undefined}
      onChange={(event) => { const next = event.target.value; onChange(numeric && next !== '' && Number.isFinite(Number(next)) ? Number(next) : next); }} />
  </FormRow>;
}

export function SchemaForm(props: SchemaFormProps) {
  const [advanced, setAdvanced] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  return <div className="grid min-w-0 gap-4 [&>button]:justify-self-end [&_[data-slot=checkbox]]:min-h-5 [&_[data-slot=checkbox]]:min-w-5 max-[640px]:[&_[data-slot=checkbox]]:min-h-11 max-[640px]:[&_[data-slot=checkbox]]:min-w-11">
    <Button type="button" variant="ghost" disabled={props.disabled} onClick={() => {
      if (!advanced) { setText(JSON.stringify(props.value, null, 2)); setError(''); }
      setAdvanced(!advanced);
    }}>{advanced ? '返回表单' : '高级 JSON 编辑'}</Button>
    {advanced ? <div><p className="text-sm text-muted-foreground">高级编辑可能包含敏感字段，请避免复制或分享配置内容。只读字段仍由 schema 校验保护。</p>
      <Textarea aria-label="高级配置 JSON" className="font-mono text-xs" rows={14} disabled={props.disabled} value={text} onChange={(event) => setText(event.target.value)} />
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button type="button" variant="outline" disabled={props.disabled} onClick={() => {
        try { const parsed: unknown = JSON.parse(text); if (!isSchemaValue(parsed)) throw new Error('请输入有效 JSON'); props.onChange(parsed); setAdvanced(false); setError(''); }
        catch { setError('JSON 格式无效，请检查后重试'); }
      }}>应用 JSON 到草稿</Button></div> : <SchemaField {...props} path="" label="插件配置" />}
  </div>;
}
