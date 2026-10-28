import * as React from 'react';
import type { JsonValue } from '../../../frontend/src/plugin-sdk/index.ts';
import type { DebuggerController, DebuggerState } from './controller.ts';
import { array, isJsonObject, json, object, parseJson, text } from './protocol.ts';
import { schemaDefault, schemaLabel, simpleSchema, validateInput } from './schema.ts';
import { Badge, Button, Check, Empty, fieldClass, JsonDetails } from './ui.tsx';

function JsonInput({ value, onChange, onError, label }: { value: JsonValue; onChange: (value: JsonValue) => void; onError: (error: string) => void; label: string }) {
  const [source, setSource] = React.useState(JSON.stringify(value, null, 2));
  return <textarea aria-label={label} className={`${fieldClass} min-h-28 w-full font-mono`} value={source} onChange={(event) => {
    setSource(event.currentTarget.value);
    try { onChange(parseJson(event.currentTarget.value)); onError(''); } catch (error) { onError(error instanceof Error ? error.message : 'JSON 无效'); }
  }} />;
}
function SchemaField({ name, schema, value, required, onChange, onError }: { name: string; schema: JsonValue; value: JsonValue | undefined;
  required: boolean; onChange: (value: JsonValue | undefined) => void; onError: (error: string) => void }) {
  const item = object(schema), enumeration = array(item.enum), type = text(item.type);
  const id = React.useId();
  return <div className="space-y-1"><label htmlFor={id} className="flex items-center gap-2 text-[13px] font-medium">{schemaLabel(schema) || name}<code className="text-xs text-[#556176]">{name}</code>{required && <span className="text-[#8A4D00]">必填</span>}
    {!required && <input aria-label={`填写 ${name}`} type="checkbox" className="accent-[#6C4CF5]" checked={value !== undefined} onChange={(event) => { onChange(event.currentTarget.checked ? schemaDefault(schema) : undefined); onError(''); }} />}</label>
    {value !== undefined && (enumeration.length ? <select id={id} className={`${fieldClass} w-full`} value={JSON.stringify(value)} onChange={(event) => onChange(parseJson(event.currentTarget.value))}>
      {enumeration.map((entry, index) => <option key={index} value={JSON.stringify(entry)}>{typeof entry === 'string' ? entry : JSON.stringify(entry)}</option>)}
    </select> : type === 'boolean' ? <Check checked={value === true} onChange={onChange}>启用</Check>
      : type === 'number' || type === 'integer' ? <input id={id} type="number" className={`${fieldClass} w-full`} value={typeof value === 'number' ? value : ''}
        min={typeof item.minimum === 'number' ? item.minimum : undefined} max={typeof item.maximum === 'number' ? item.maximum : undefined} step={type === 'integer' ? 1 : 'any'}
        onChange={(event) => { const next = event.currentTarget.valueAsNumber; if (Number.isFinite(next)) { onChange(next); onError(''); } else onError(`${name}需要有效数字`); }} />
      : type === 'string' ? <input id={id} className={`${fieldClass} w-full`} value={typeof value === 'string' ? value : ''}
        onChange={(event) => onChange(event.currentTarget.value)} />
      : <JsonInput key={name} label={`${name} JSON`} value={value} onChange={onChange} onError={onError} />)}
    {text(item.description) && <p className="text-xs text-[#556176]">{text(item.description)}</p>}
  </div>;
}
export function InvokeView({ state, controller }: { state: DebuggerState; controller: DebuggerController }) {
  const [key, setKey] = React.useState('');
  const entry = state.entries.find((item) => item.key === key);
  const [input, setInput] = React.useState<JsonValue>({}), [jsonMode, setJsonMode] = React.useState(false);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [confirmed, setConfirmed] = React.useState(false), [allowUnknown, setAllowUnknown] = React.useState(false), [includeResult, setIncludeResult] = React.useState(false);
  React.useEffect(() => { setKey(''); setConfirmed(false); setAllowUnknown(false); setIncludeResult(false); }, [state.sessionId]);
  const changeInput = (next: JsonValue) => { setInput(next); setConfirmed(false); setAllowUnknown(false); };
  const errors = entry ? [...Object.values(fieldErrors).filter(Boolean), ...validateInput(input, entry.schema)] : [];
  const properties = object(object(entry?.schema).properties), required = array(object(entry?.schema).required);
  function choose(next: string) {
    const chosen = state.entries.find((item) => item.key === next);
    setKey(next); setInput(chosen ? schemaDefault(chosen.schema) : {}); setJsonMode(chosen ? !simpleSchema(chosen.schema) : false);
    setFieldErrors({}); setConfirmed(false); setAllowUnknown(false); setIncludeResult(false);
  }
  return <section className="space-y-4">
    <h2 className="text-[15px] font-semibold">试调用公开入口</h2>
    <p className="rounded-md bg-[#FDF6ED] p-3 text-[13px] text-[#8A4D00]">调用可能间接影响设备或外部资源。每次提交都需要两项确认，取消等待不代表停止执行；未知结果不自动重试。</p>
    {!state.entries.length ? <Empty title="当前目标没有可试调用的公开入口">请先选择目标并刷新检查。服务器操作和服务均沿原任务执行，服务另需精确版本。</Empty> : <>
      <label className="block text-[13px]">当前插件公开目录<select aria-label="试调用入口" className={`${fieldClass} mt-1 w-full`} value={key} onChange={(event) => choose(event.currentTarget.value)}><option value="">请明确选择调用入口</option>{state.entries.map((item) => <option key={item.key} value={item.key}>{item.kind === 'service' ? '服务' : item.kind === 'operation' ? '操作' : '命令'} · {item.id}{item.version ? ` @ ${item.version}` : ''}{!item.available ? ' · 当前不可用' : ''}</option>)}</select></label>
      {entry && <div className="space-y-3 rounded-lg border border-[#E6EAF3] p-4">
        <div className="flex flex-wrap items-center gap-2"><Badge>{entry.kind}</Badge><code className="break-all text-xs">{entry.id}{entry.version ? ` @ ${entry.version}` : ''}</code></div>
        {entry.reason && <p className="text-[13px] text-[#556176]">{entry.reason}</p>}
        {simpleSchema(entry.schema) && <Check checked={jsonMode} onChange={(value) => { setJsonMode(value); setFieldErrors({}); setConfirmed(false); setAllowUnknown(false); }}>改用完整 JSON 输入</Check>}
        {!jsonMode && simpleSchema(entry.schema) && isJsonObject(input) ? <div className="grid grid-cols-2 gap-3 max-[700px]:grid-cols-1">{Object.entries(properties).map(([name, schema]) => <SchemaField key={name} name={name} schema={json(schema)} value={input[name]} required={required.includes(name)}
          onChange={(value) => { const next = { ...input }; if (value === undefined) delete next[name]; else next[name] = value; changeInput(next); }}
          onError={(error) => setFieldErrors((current) => ({ ...current, [name]: error }))} />)}</div>
          : <JsonInput key={`${key}:${jsonMode}`} label="调用输入 JSON" value={input} onChange={changeInput} onError={(error) => setFieldErrors({ input: error })} />}
        <p className="text-xs text-[#556176]">表单依据 catalog 输入模式。复杂引用、组合条件与正则最终由原服务验证，原准入与错误保留。</p>
        {errors.length > 0 && <ul role="alert" className="list-inside list-disc text-[13px] text-[#8A4D00]">{errors.map((error, index) => <li key={index}>{error}</li>)}</ul>}
        {state.target?.kind === 'browser' && <Check checked={includeResult} onChange={(value) => { setIncludeResult(value); setConfirmed(false); setAllowUnknown(false); }}>本次包含脱敏结果正文（默认仅元数据）</Check>}
        <Check checked={confirmed} onChange={setConfirmed}>确认调用当前插件、代次和入口，参数已核对</Check>
        <Check checked={allowUnknown} onChange={setAllowUnknown}>允许未知副作用，可能影响设备或外部资源</Check>
        <Button primary disabled={Boolean(state.busy) || state.stale || !state.connected || !entry.available || !confirmed || !allowUnknown || errors.length > 0}
          onClick={() => { void controller.invoke(entry, input, confirmed, allowUnknown, includeResult); setConfirmed(false); setAllowUnknown(false); }}>执行一次调用</Button>
        <JsonDetails value={entry.schema} label="输入模式" />
      </div>}
    </>}
  </section>;
}
