import * as React from 'react';
import type { DebuggerController, DebuggerState, EventRow } from './controller.ts';
import { array, object, targetKey, text } from './protocol.ts';
import { Badge, Button, Check, CopyId, Empty, fieldClass, JsonDetails } from './ui.tsx';

export function TimelineView({ state, controller }: { state: DebuggerState; controller: DebuggerController }) {
  const [level, setLevel] = React.useState(''), [includeOld, setIncludeOld] = React.useState(true), [search, setSearch] = React.useState('');
  const [follow, setFollow] = React.useState(false), [selected, setSelected] = React.useState<EventRow | null>(null);
  const [query, setQuery] = React.useState(''), [byId, setById] = React.useState(true);
  const end = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!follow || !state.open || !state.sessionId || state.stale) return;
    const timer = setInterval(() => { void controller.events(); }, 3000);
    return () => clearInterval(timer);
  }, [controller, follow, state.open, state.sessionId, state.stale]);
  React.useEffect(() => { if (follow) end.current?.scrollIntoView({ block: 'nearest' }); }, [state.events.length, follow]);
  const rows = state.events.filter((row) => (!level || row.level === level) &&
    (includeOld || !state.target || (row.target && targetKey(row.target) === targetKey(state.target))) &&
    (!search || `${row.label} ${row.logId ?? ''} ${row.target?.pluginId ?? ''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())));
  const logs = object(state.logs);
  return <div className="space-y-4">
    <h2 className="text-[15px] font-semibold">事件时间线与公共日志</h2>
    <p className="rounded-md bg-[#FDF6ED] p-3 text-[13px] text-[#8A4D00]">历史清理失败保留；新代成功不会擦除旧代失败。只约束真实资源冲突，无需先清空旧债务。</p>
    <div className="flex flex-wrap items-center gap-3">
      <select aria-label="事件级别" className={fieldClass} value={level} onChange={(event) => setLevel(event.currentTarget.value)}><option value="">全部级别</option><option value="info">信息</option><option value="error">错误 / 未确认</option></select>
      <Check checked={includeOld} onChange={setIncludeOld}>包含旧代：{includeOld ? '开' : '关'}</Check>
      <input aria-label="搜索事件" className={`${fieldClass} min-w-32 flex-1`} placeholder="搜索事件、插件、日志 ID" value={search} onChange={(event) => setSearch(event.currentTarget.value)} />
      <span className="text-[13px] text-[#556176]">{follow ? '自动跟随中' : '已暂停跟随'}</span>
      <Button onClick={() => setFollow(!follow)}>{follow ? '暂停跟随' : '继续跟随'}</Button>
      <Button disabled={!state.sessionId || Boolean(state.busy)} onClick={() => void controller.events()}>读取下一页</Button>
    </div>
    {(state.eventGap || state.droppedEvents > 0) && <p role="status" className="text-[13px] text-[#8A4D00]">事件游标存在缺口或截断：宿主已丢弃 {state.droppedEvents} 条。前端仅保留最近 500 条缓存，缺失不等于未发生。</p>}
    <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(230px,1fr)] gap-4 max-[700px]:grid-cols-1">
      <section className="max-h-80 min-w-0 overflow-auto rounded-lg border border-[#E6EAF3]" aria-label="事件列表">
        {!rows.length ? <Empty title="暂无匹配的已缓存事件">可手动读取下一页，或继续跟随。暂停仅影响自动读取，不暂停业务。</Empty> : <table className="w-full text-left text-[13px]">
          <thead className="sticky top-0 bg-[#F7F8FC] text-[#556176]"><tr><th className="p-2">序号</th><th className="p-2">事件</th><th className="p-2">代次</th></tr></thead>
          <tbody>{rows.map((row) => <tr key={row.key} className={`${row.level === 'error' ? 'bg-[#FDF6ED]' : ''} border-t border-[#E6EAF3]`}><td className="p-2 font-mono text-xs">{row.sequence}</td>
            <td className="p-2"><button type="button" className="w-full break-all text-left outline-none focus-visible:ring-2 focus-visible:ring-[#6C4CF5]" onClick={() => setSelected(row)}>{row.label}</button></td><td className="p-2 font-mono text-xs">{row.target?.generation ?? '未知'}</td></tr>)}</tbody>
        </table>}<div ref={end} />
      </section>
      <section className="min-w-0 space-y-3 rounded-lg border border-[#E6EAF3] p-3" aria-label="事件详情">
        {selected ? <><h3 className="break-all text-sm font-medium">{selected.label}</h3><Badge warning={selected.level === 'error'}>{selected.level}</Badge>
          <p className="break-all text-xs text-[#556176]">{selected.target?.pluginId ?? '目标未知'} · {selected.target?.generation ?? '代次未知'}</p>
          <CopyId value={selected.logId} /><JsonDetails value={selected.raw} label="事件详情" /></> : <Empty title="选择事件查看详情" />}
      </section>
    </div>
    <section className="space-y-3 rounded-lg border border-[#E6EAF3] p-4"><h3 className="text-sm font-semibold">服务器公共日志搜索</h3>
      <form className="flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); void controller.logs(query, byId); }}>
        <select aria-label="日志查询方式" className={fieldClass} value={byId ? 'id' : 'text'} onChange={(event) => setById(event.currentTarget.value === 'id')}><option value="id">日志 ID / 任务 ID</option><option value="text">关键词</option></select>
        <input aria-label="日志查询" className={`${fieldClass} min-w-40 flex-1`} value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder={byId ? '填写完整日志 ID 或任务 ID' : '1 至 128 字节搜索词'} />
        <Button type="submit" disabled={Boolean(state.busy) || !query.trim()}>查询日志</Button>
        {state.logId && <Button onClick={() => { setById(true); setQuery(state.logId ?? ''); }}>带入最近日志 ID</Button>}
      </form>
      {logs.limited === true && <p className="text-[13px] text-[#8A4D00]">结果已截断，仅展示公开搜索返回的有界条目。</p>}
      {state.logs !== null && <div className="max-h-72 overflow-auto">{array(logs.entries).length ? array(logs.entries).map((raw, index) => {
        const log = object(raw); return <article key={index} className="space-y-1 border-b border-[#E6EAF3] py-2 text-[13px]">
          <div className="flex flex-wrap gap-2"><Badge warning={text(log.level).toLowerCase() === 'error'}>{text(log.level)}</Badge><time className="text-xs text-[#556176]">{text(log.timestamp)}</time><code className="text-xs">{text(log.code)}</code></div>
          <p className="break-all">{text(log.message)}</p><CopyId value={text(log.log_id) || null} />
        </article>;
      }) : <p className="py-3 text-[13px] text-[#556176]">未找到匹配的公开日志，不能据此推断业务没有运行。</p>}</div>}
    </section>
  </div>;
}
