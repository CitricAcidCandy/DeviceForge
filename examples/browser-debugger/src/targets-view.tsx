import * as React from 'react';
import type { DebuggerController, DebuggerState } from './controller.ts';
import { array, object, targetKey, text } from './protocol.ts';
import { Badge, Button, Definition, Empty, fieldClass, JsonDetails } from './ui.tsx';

export function TargetsView({ state, controller }: { state: DebuggerState; controller: DebuggerController }) {
  const [kind, setKind] = React.useState('browser');
  const [instance, setInstance] = React.useState(state.instanceId ?? '');
  const [search, setSearch] = React.useState('');
  React.useEffect(() => { if (state.instanceId) setInstance(state.instanceId); }, [state.instanceId]);
  const requested = state.requested;
  const candidates = state.targets.filter((target) => requested
    ? requested.candidates.some((item) => item.kind === target.kind && item.pluginId === target.pluginId)
    : target.kind === kind && (kind === 'server' || target.instanceId === instance));
  const targets = candidates.filter((target) => target.pluginId.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center gap-2"><h2 className="mr-auto text-[15px] font-semibold">要调试哪个插件？</h2><Button disabled={Boolean(state.busy)} onClick={() => void controller.refreshTargets()}>刷新插件列表</Button></div>
    {requested && <div className="flex flex-wrap items-center gap-2 rounded-md bg-[#EFEBFF] p-3 text-[13px] text-[#6C4CF5]">
      <span>市场带入 {requested.candidates.length} 个候选组件{requested.installationId ? ` · 安装 ${requested.installationId}` : ''}，请明确选择组件和实例。</span><Button onClick={() => controller.clearRequested()}>显示全部目标</Button></div>}
    <div className="flex flex-wrap gap-3">
      {!requested && <><label className="text-[13px]">目标类型 <select aria-label="目标类型" className={fieldClass} value={kind} onChange={(event) => setKind(event.currentTarget.value)}><option value="browser">浏览器插件</option><option value="server">服务器插件</option></select></label>
        {kind === 'browser' && <label className="min-w-0 text-[13px]">浏览器实例 <select aria-label="浏览器实例" className={`${fieldClass} max-w-80`} value={instance} onChange={(event) => setInstance(event.currentTarget.value)}>
          <option value="">请选择实例</option>{[...new Set(state.targets.filter((target) => target.kind === 'browser').map((target) => target.instanceId))].filter(Boolean).map((id) => <option key={id} value={id ?? ''}>{id === state.instanceId ? '当前实例 · ' : '其他实例 · '}{id}</option>)}
        </select></label>}</>}
      <input aria-label="筛选插件" className={`${fieldClass} min-w-36 flex-1`} value={search} onChange={(event) => setSearch(event.currentTarget.value)} placeholder="输入插件名称或标识" />
    </div>
    {!targets.length ? <Empty title={requested ? '候选组件尚未出现在运行目录' : '尚无可调试目标'}>请在原市场入口启用组件，或确认选定实例在线后刷新目录。安装存在不代表此浏览器已经启用。</Empty>
      : <div className="grid grid-cols-2 gap-3 max-[700px]:grid-cols-1">{targets.map((target) => <article key={targetKey(target)}
        className={`${state.target && targetKey(state.target) === targetKey(target) ? 'border-[#6C4CF5] bg-[#EFEBFF]' : 'border-[#E6EAF3] bg-white'} min-w-0 space-y-2 rounded-lg border p-4`}>
        <div className="flex flex-wrap items-center gap-2"><h3 className="min-w-0 flex-1 break-all text-sm font-semibold">{target.pluginId}</h3><Badge>{target.kind === 'browser' ? '浏览器' : '服务器'}</Badge></div>
        <p className="break-all text-xs text-[#556176]">{target.instanceId === state.instanceId ? '当前实例' : target.instanceId || '服务器宿主'} · {target.version || '版本未提供'}</p>
        <details className="text-xs text-[#556176]"><summary className="cursor-pointer">完整目标身份</summary><p className="mt-2 break-all">实例 <code>{target.instanceId ?? '服务器'}</code> · 代次 <code>{target.generation ?? '未提供'}</code></p></details>
        <Button disabled={Boolean(state.busy)} primary onClick={() => void controller.select(target)}>选择并查看调试过程</Button>
      </article>)}</div>}
    {state.target && <details className="space-y-3 rounded-lg border border-[#E6EAF3] p-4"><summary className="cursor-pointer text-sm font-semibold">当前目标能力与证据</summary>
      <dl><Definition label="选定插件"><code>{state.target.pluginId}</code></Definition><Definition label="完整实例"><code>{state.target.instanceId || '服务器目标'}</code></Definition><Definition label="代次"><code>{state.target.generation || '未提供'}</code></Definition></dl>
      <div className="flex flex-wrap gap-2">{Object.entries(object(object(state.inspection).capabilities)).filter(([, value]) => typeof value === 'boolean').map(([key, value]) => <Badge key={key} warning={!value}>{key}：{value ? '支持' : '未提供'}</Badge>)}</div>
      {array(object(state.inspection).cleanup_history).length > 0 && <div className="rounded-md bg-[#FDF6ED] p-3 text-[13px] text-[#8A4D00]">旧代清理失败保留供诊断，不阻止独立新调用。<JsonDetails value={object(state.inspection).cleanup_history} label="查看历史清理告警" /></div>}
      <JsonDetails value={state.inspection} label="检查详情、登记资源与生命周期" />
    </details>}
  </div>;
}

export function CatalogView({ state, controller }: { state: DebuggerState; controller: DebuggerController }) {
  const overview = object(state.overview), page = object(overview.page);
  const slots = array(object(state.inspection).slot_catalog), mounts = array(object(state.inspection).mount_catalog);
  const rows = array(overview.nodes).length ? array(overview.nodes) : [...slots.map((slot) => ({ kind: 'slot', catalog: slot })), ...mounts.map((mount) => ({ kind: 'mount', catalog: mount }))];
  return <section className="space-y-3">
    <div className="flex flex-wrap items-center gap-2"><h2 className="mr-auto text-[15px] font-semibold">公开槽位、路由与挂载目录</h2><Button disabled={!state.sessionId || state.stale || Boolean(state.busy)} onClick={() => void controller.overview()}>读取目录</Button></div>
    <p className="rounded-md bg-[#F7F8FC] p-3 text-[13px] text-[#556176]">目录证据 catalog-only。槽位可用于公开贡献；路由仅作宿主明确允许的导航；未实例化条目不推导 DOM。</p>
    {!rows.length ? <Empty title="尚未读取公开目录">先选择目标并读取目录。普通 DOM 节点与面板不自动成为插入槽位。</Empty> : <div className="space-y-2">{rows.map((raw, index) => {
      const row = object(raw), catalog = object(row.catalog);
      const id = text(catalog.id) || text(catalog.path) || text(catalog.contribution_id) || `条目 ${index + 1}`;
      return <article key={`${text(row.kind)}:${id}:${index}`} className="rounded-lg border border-[#E6EAF3] p-3">
        <div className="flex flex-wrap items-center gap-2"><Badge>{text(row.kind, '目录')}</Badge><strong className="break-all text-sm">{text(catalog.label) || id}</strong></div>
        <p className="my-2 break-all text-xs text-[#556176]">{id} · {catalog.mounted === true || catalog.mounted_by_target === true ? '当次证据：已挂载' : catalog.instantiated === true ? '已实例化' : '未观测到实例化'}{catalog.slot_id === null ? ' · 非插入槽位' : ''}</p>
        {row.kind === 'route' && text(catalog.path) && <NavigateButton path={text(catalog.path)} controller={controller} disabled={state.stale || Boolean(state.busy)} />}
        <JsonDetails value={catalog} label="目录证据" />
      </article>;
    })}</div>}
    {typeof page.total === 'number' && <p className="text-xs text-[#556176]">目录总数 {page.total} · {typeof page.nextOffset === 'number' ? '仍有后续分页' : '当前目录页已到末尾'}</p>}
    {typeof page.nextOffset === 'number' && <Button disabled={state.stale || Boolean(state.busy)} onClick={() => void controller.overview(Number(page.nextOffset))}>下一页目录</Button>}
  </section>;
}
function NavigateButton({ path, controller, disabled }: { path: string; controller: DebuggerController; disabled: boolean }) {
  const [confirmed, setConfirmed] = React.useState(false);
  return <div className="my-2 flex flex-wrap items-center gap-2"><label className="text-[13px]"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.currentTarget.checked)} className="mr-2 accent-[#6C4CF5]" />确认导航到此公开路由</label>
    <Button disabled={disabled || !confirmed} onClick={() => { void controller.navigate(path, confirmed); setConfirmed(false); }}>导航</Button></div>;
}
