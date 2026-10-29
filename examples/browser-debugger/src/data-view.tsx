import * as React from 'react';
import type { JsonValue } from '../../../frontend/src/plugin-sdk/index.ts';
import type { DebuggerController, DebuggerState } from './controller.ts';
import { array, isJsonObject, json, object, parseJson } from './protocol.ts';
import { simpleSchema, validateInput } from './schema.ts';
import { JsonInput, SchemaField } from './invoke-view.tsx';
import { Badge, Button, Empty, fieldClass, JsonDetails } from './ui.tsx';

export function DataView({ state, controller, narrow }: { state: DebuggerState; controller: DebuggerController; narrow: boolean }) {
  const [sourceId, setSourceId] = React.useState('');
  const [baseRevision, setBaseRevision] = React.useState('');
  const [draft, setDraft] = React.useState<JsonValue>(null);
  const [dirty, setDirty] = React.useState(false);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [jsonText, setJsonText] = React.useState('null');
  const [pendingSource, setPendingSource] = React.useState('');
  const mounted = React.useRef(true);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const snapshot = state.dataSnapshot?.sourceId === sourceId ? state.dataSnapshot : null;
  const source = state.dataSources.find(item => item.id === sourceId);
  const compare = dirty && snapshot && snapshot.revision !== baseRevision;
  const disabled = state.stale || !state.connected || Boolean(state.busy);
  React.useEffect(() => { setSourceId(''); setPendingSource(''); setBaseRevision(''); setDirty(false); setDraft(null); setFieldErrors({}); }, [state.sessionId]);
  React.useEffect(() => {
    if (!snapshot || dirty) return;
    setDraft(snapshot.value); setJsonText(JSON.stringify(snapshot.value, null, 2)); setBaseRevision(snapshot.revision); setFieldErrors({});
  }, [snapshot, dirty]);
  function choose(id: string) {
    if (dirty) { setPendingSource(id); return; }
    selectSource(id);
  }
  function selectSource(id: string) {
    setPendingSource('');
    setSourceId(id); setDirty(false); setDraft(null); setBaseRevision(''); setFieldErrors({});
    void controller.readDataSource(id);
  }
  function change(value: JsonValue) { setDraft(value); setJsonText(JSON.stringify(value, null, 2)); setDirty(true); }
  async function save() {
    if (!source || !baseRevision || !snapshot || compare) return;
    const sessionId = state.sessionId;
    await controller.writeDataSource(source.id, baseRevision, draft, true);
    const latest = controller.snapshot();
    if (mounted.current && latest.sessionId === sessionId && !latest.error && !latest.dataConflict && latest.dataSnapshot?.sourceId === sourceId && latest.dataSnapshot.revision !== baseRevision) {
      setDirty(false); setBaseRevision(latest.dataSnapshot.revision); setDraft(latest.dataSnapshot.value); setJsonText(JSON.stringify(latest.dataSnapshot.value, null, 2));
    }
  }
  if (state.target?.kind === 'server') return <Empty title="服务器数据通过公开能力读取">服务器插件仍沿原公开服务与任务入口使用。此面板只显示浏览器插件主动登记的数据源。</Empty>;
  const errors = source && snapshot ? [...Object.values(fieldErrors).filter(Boolean), ...(source.schemaComplete ? validateInput(draft, source.schema) : [])] : [];
  const policy = source?.applyPolicy === 'next_invocation' ? '下次调用生效' : source?.applyPolicy === 'reload' ? '重载后生效' : source?.applyPolicy === 'immediate' ? '按插件声明立即生效' : '生效方式未提供，请核对插件';
  return <div className={`grid gap-6 ${narrow ? 'grid-cols-1' : 'grid-cols-[224px_minmax(0,1fr)]'}`}>
    <aside className="space-y-4"><div className="flex flex-wrap items-center gap-2"><h2 className="mr-auto text-sm font-semibold">插件公开的数据</h2><Button disabled={disabled} onClick={() => void controller.refreshDataSources()}>刷新</Button></div>
      {state.dataSources.length ? <div className="space-y-2">{state.dataSources.map(item => <button key={item.id} type="button" disabled={disabled} aria-pressed={item.id === sourceId} onClick={() => choose(item.id)}
        className={`${item.id === sourceId ? 'bg-[#EFEBFF] text-[#6C4CF5]' : 'bg-white text-[#23272E]'} min-h-24 w-full rounded-xl p-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-[#6C4CF5] disabled:opacity-50`}>
        <span className="block text-sm font-medium">{item.label}</span><span className="mt-2 block text-xs text-[#556176]">{item.writable ? '可修改' : '只读'} · {item.persistence === 'persistent' ? '持久保存' : item.persistence === 'memory' ? '内存数据' : '持久性未提供'}</span></button>)}</div>
        : <p className="rounded-xl bg-[#F7F8FC] p-4 text-[13px] leading-relaxed text-[#556176]">插件尚未公开数据源。空目录不代表插件没有内部状态。</p>}
      <p className="text-[13px] leading-relaxed text-[#556176]">只列出插件主动公开的数据。修改不会读取插件私有状态。</p>
      {pendingSource && <div className="space-y-3 rounded-lg bg-[#FDF6ED] p-3 text-[13px] text-[#8A4D00]"><p>当前编辑尚未保存，切换会放弃这些编辑。</p><Button onClick={() => selectSource(pendingSource)}>放弃编辑并切换</Button><Button onClick={() => setPendingSource('')}>继续编辑</Button></div>}
    </aside>
    {!source || !snapshot ? <Empty title={source ? '正在读取公开数据' : '选择一个公开数据源'}>在左侧选择数据后，可以查看业务字段、只读状态和生效方式。{state.dataNotice && <p className="mt-3">{state.dataNotice}</p>}</Empty>
      : <section className="min-w-0 space-y-5">
        <div className="space-y-2"><h3 className="text-lg font-semibold">{source.label}</h3><p className="text-sm text-[#8A4D00]">{dirty ? '有未保存修改 · ' : ''}{policy}</p>{!source.writable && <Badge>只读数据源</Badge>}</div>
        {state.dataNotice && <p role="status" className="rounded-xl bg-[#FDF6ED] p-4 text-sm leading-relaxed text-[#8A4D00]">{state.dataNotice}</p>}
        {state.dataConflict && <div role="alert" className="space-y-2 rounded-xl bg-[#FDF6ED] p-5 text-sm leading-relaxed text-[#8A4D00]"><h4 className="font-semibold">数据已发生变化，你的编辑已保留</h4><p>其他调用已经更新了这份数据。本次保存未覆盖新值，请读取最新值后比较。</p></div>}
        <fieldset disabled={disabled || !source.writable} className="min-w-0 space-y-5 disabled:opacity-60">
          {simpleSchema(source.schema) && isJsonObject(draft) ? Object.entries(object(object(source.schema).properties)).map(([name, schema]) => <fieldset key={name} disabled={object(schema).readOnly === true}>
            <SchemaField name={name} schema={json(schema)} value={draft[name]} required={array(object(source.schema).required).includes(name)} onChange={value => {
              if (!isJsonObject(draft)) return;
              const next = { ...draft }; if (value === undefined) delete next[name]; else next[name] = value; change(next);
            }} onError={error => setFieldErrors(current => ({ ...current, [name]: error }))} />
          </fieldset>) : <JsonInput key={`${sourceId}:${baseRevision}`} value={draft} label="公开数据JSON" onChange={change} onError={error => setFieldErrors({ json: error })} />}
        </fieldset>
        {compare && <div className="space-y-4 rounded-xl border border-[#E6EAF3] bg-[#F7F8FC] p-4"><h4 className="text-sm font-semibold">最新值已读取，你的编辑仍保留</h4>
          <JsonDetails value={snapshot.value} label="查看刚读取的最新值" /><p className="text-[13px] text-[#556176]">比较后明确选择要保留的内容；这里不会自动保存。</p>
          <div className="flex flex-wrap gap-3"><Button onClick={() => { setBaseRevision(snapshot.revision); }}>保留我的编辑，使用最新修订</Button><Button onClick={() => { setDirty(false); setDraft(snapshot.value); setJsonText(JSON.stringify(snapshot.value, null, 2)); setBaseRevision(snapshot.revision); }}>采用最新值，放弃我的编辑</Button></div>
        </div>}
        <details className="text-[13px] text-[#556176]"><summary className="cursor-pointer">高级 JSON 与修订信息</summary><div className="mt-3 space-y-3">
          <p className="break-all">当前编辑基于修订 <code>{baseRevision}</code></p>
          {!source.schemaComplete && <p className="text-[#8A4D00]">模式含被省略的敏感字段，不能用脱敏占位值恢复秘密。</p>}
          <textarea aria-label="高级数据JSON" className={`${fieldClass} min-h-40 w-full font-mono`} disabled={disabled || !source.writable} value={jsonText} onChange={event => {
            setJsonText(event.currentTarget.value); setDirty(true);
            try { setDraft(parseJson(event.currentTarget.value)); setFieldErrors({}); } catch (error) { setFieldErrors({ json: error instanceof Error ? error.message : 'JSON无效' }); }
          }} /><JsonDetails value={source.schema} label="公开数据模式" />
        </div></details>
        {errors.length > 0 && <ul role="alert" className="list-inside list-disc text-[13px] text-[#8A4D00]">{errors.map((error, index) => <li key={index}>{error}</li>)}</ul>}
        <div className="flex flex-wrap gap-3">{source.writable && !state.dataConflict && !state.error?.unconfirmed && <Button primary disabled={disabled || !dirty || !baseRevision || Boolean(compare) || errors.length > 0} onClick={() => void save()}>保存这次修改</Button>}
          <Button primary={state.dataConflict || state.error?.unconfirmed === true} disabled={disabled} onClick={() => void controller.readDataSource(sourceId)}>{state.error?.unconfirmed ? '读取实际状态并比较' : dirty || state.dataConflict ? '读取最新值并比较' : '重新读取数据'}</Button></div>
      </section>}
  </div>;
}
