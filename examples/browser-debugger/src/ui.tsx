import * as React from 'react';
import type { JsonValue } from '../../../frontend/src/plugin-sdk/index.ts';
import { array, object, text } from './protocol.ts';

export const fieldClass = 'min-w-0 rounded-md border border-[#7A879B] bg-white px-2 py-1.5 text-[13px] text-[#23272E] outline-none focus-visible:ring-2 focus-visible:ring-[#6C4CF5] disabled:cursor-not-allowed disabled:opacity-50';
export function Button({ children, primary = false, soft = false, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean; soft?: boolean }) {
  return <button type="button" {...props} className={`${primary
    ? 'border-[#6C4CF5] bg-[#6C4CF5] text-white hover:bg-[#5835DA]'
    : soft ? 'border-transparent bg-[#EFEBFF] text-[#6C4CF5] hover:bg-[#F7F8FC]'
      : 'border-[#E6EAF3] bg-white text-[#23272E] hover:bg-[#F7F8FC]'} min-h-9 shrink-0 rounded-lg border px-3 py-1.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-[#6C4CF5] disabled:cursor-not-allowed disabled:opacity-50 ${props.className ?? ''}`}>
    {children}
  </button>;
}
export function Badge({ children, warning = false }: { children: React.ReactNode; warning?: boolean }) {
  return <span className={`${warning ? 'bg-[#FDF6ED] text-[#8A4D00]' : 'bg-[#EFEBFF] text-[#6C4CF5]'} inline-flex rounded px-1.5 py-0.5 text-xs`}>{children}</span>;
}
export function Check({ checked, onChange, children, disabled = false }: { checked: boolean; onChange: (value: boolean) => void; children: React.ReactNode; disabled?: boolean }) {
  return <label className="flex cursor-pointer items-start gap-2 text-[13px] text-[#556176]">
    <input type="checkbox" className="mt-0.5 size-4 accent-[#6C4CF5] focus-visible:ring-2 focus-visible:ring-[#6C4CF5]" checked={checked}
      disabled={disabled} onChange={(event) => onChange(event.currentTarget.checked)} />{children}
  </label>;
}
export function JsonDetails({ value, label = '查看辅助 JSON' }: { value: unknown; label?: string }) {
  return <details className="min-w-0 rounded-lg border border-[#E6EAF3] bg-[#FBFCFE] text-[13px]">
    <summary className="cursor-pointer px-3 py-2 text-[#556176] focus-visible:ring-2 focus-visible:ring-[#6C4CF5]">{label}</summary>
    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all border-t border-[#E6EAF3] p-3 text-xs text-[#23272E]">{JSON.stringify(value, null, 2)}</pre>
  </details>;
}
export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return <div className="flex min-h-40 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-[#E6EAF3] p-6 text-center">
    <p className="text-sm font-medium text-[#23272E]">{title}</p><div className="max-w-xl text-[13px] leading-relaxed text-[#556176]">{children}</div>
  </div>;
}
export function Definition({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="grid min-w-0 grid-cols-[100px_minmax(0,1fr)] gap-2 border-b border-[#E6EAF3] py-2 text-[13px]">
    <dt className="text-[#556176]">{label}</dt><dd className="min-w-0 break-all text-[#23272E]">{children}</dd>
  </div>;
}
export async function copyText(value: string, document: Document): Promise<void> {
  if (document.defaultView?.navigator.clipboard?.writeText) {
    await document.defaultView.navigator.clipboard.writeText(value); return;
  }
  const previous = document.activeElement;
  const input = document.createElement('textarea');
  input.value = value; input.className = 'fixed left-0 top-0 size-px opacity-0';
  input.setAttribute('aria-label', '复制日志 ID'); document.body.append(input); input.select();
  try { if (!document.execCommand('copy')) throw new Error('复制不可用，请选择并手动复制日志 ID'); }
  finally { input.remove(); if (previous instanceof HTMLElement) previous.focus(); }
}
export function CopyId({ value, label = '复制日志 ID' }: { value: string | null; label?: string }) {
  const [status, setStatus] = React.useState('');
  const ref = React.useRef<HTMLSpanElement>(null);
  if (!value) return <span className="text-xs text-[#556176]">未提供日志 ID</span>;
  return <span ref={ref} className="inline-flex min-w-0 flex-wrap items-center gap-2">
    <code className="break-all text-xs" title={value}>{value}</code>
    <Button onClick={() => { const doc = ref.current?.ownerDocument; if (doc) void copyText(value, doc)
      .then(() => setStatus('已复制'), (error: unknown) => setStatus(error instanceof Error ? error.message : '复制失败')); }}>{label}</Button>
    <span role="status" className="text-xs text-[#556176]">{status}</span>
  </span>;
}
export function ResultView({ value }: { value: JsonValue }) {
  if (value === null) return null;
  const result = object(value), metadata = object(result.result_metadata), artifact = object(result.artifact);
  const status = text(result.status) || text(result.state), host = object(result.host), owner = object(result.owner);
  return <section aria-label="最近操作结果" className="space-y-3 rounded-lg border border-[#E6EAF3] bg-[#FBFCFE] p-3">
    <div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-medium">最近操作结果</h3>{status && <Badge warning={/failed|rejected|indeterminate|unconfirmed/.test(status)}>{status}</Badge>}</div>
    {text(result.reason) && <p className="text-[13px] text-[#556176]">{text(result.reason)}</p>}
    {result.source === 'host-dom' && <><h4 className="text-sm font-medium">宿主节点 · 只读身份</h4><dl>
      <Definition label="名称">{text(host.label, '未提供')}</Definition><Definition label="标签 / 角色">{text(host.tag)} · {text(host.role, '未提供')}</Definition>
      <Definition label="插入能力">此普通节点不可插入</Definition><Definition label="最近公开槽位">{typeof host.nearest_slot === 'string' ? host.nearest_slot : text(object(host.nearest_slot).id, '未观测到真实公开祖先槽位')}</Definition>
      <Definition label="所在路由">{typeof host.route === 'string' ? host.route : text(object(host.route).path, '未提供')}</Definition>
    </dl><p className="text-[13px] text-[#556176]">该身份没有插件节点引用，不能点击、填值或作为插件动作目标。</p></>}
    {text(owner.pluginId) && <p className="break-all text-[13px]">拾取归属：<code>{text(owner.pluginId)}</code> · 代次 <code>{String(owner.generation ?? '未提供')}</code></p>}
    {typeof result.matched === 'number' && <p className="text-sm">命中 {result.matched} 个节点</p>}
    {['added', 'removed', 'changed'].some((key) => Array.isArray(result[key])) && <div className="flex gap-4 text-sm">
      <span>新增 {array(result.added).length}</span><span>移除 {array(result.removed).length}</span><span>变更 {array(result.changed).length}</span>
    </div>}
    {text(result.job_id) && <dl><Definition label="原任务 ID"><code>{text(result.job_id)}</code></Definition>
      <Definition label="任务状态">{text(result.status, '请沿原任务入口查询')}</Definition></dl>}
    {metadata.included === false && <p className="text-[13px] text-[#556176]">结果正文未收集：{text(metadata.type)}，{String(metadata.bytes ?? '未知')} 字节。</p>}
    {result.businessOutcome === 'unknown' && <p className="text-[13px] text-[#8A4D00]">业务结果未知；合成事件派发不代表设备或业务操作成功。</p>}
    {text(artifact.id) && <p className="text-[13px]">报告产物：<code>{text(artifact.id)}</code></p>}
    <JsonDetails value={value} />
  </section>;
}
