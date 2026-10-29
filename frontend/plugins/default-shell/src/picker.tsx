import { useEffect, useRef, useState } from 'react';
import type { WorkspaceViewRef } from '@deviceforge/plugin-sdk';
import type { ShellController, ShellState } from './controller.ts';
import type { Placement } from './layout.ts';

export function ProviderPicker({ state, controller, replacing, onClose }: {
  readonly state: ShellState; readonly controller: ShellController;
  readonly replacing: string | null; readonly onClose: () => void;
}) {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<WorkspaceViewRef | null>(null);
  const [placement, setPlacement] = useState<Placement>('split');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const views = state.model.catalog.views.filter((view) =>
    !view.provides.includes('host.shell') && `${view.title} ${view.pluginId}`.toLowerCase().includes(search.toLowerCase()));
  async function submit() {
    if (!selected || busy) return;
    const cancellation = new AbortController();
    request.current = cancellation;
    setBusy(true); setError(null);
    try {
      if (replacing) await controller.replace(replacing, selected, cancellation.signal);
      else await controller.add(selected, placement, cancellation.signal);
      onClose();
    } catch (failure) {
      if (!cancellation.signal.aborted) setError(failure instanceof Error ? failure.message : '准备失败，原视图仍然可用');
    } finally { if (!cancellation.signal.aborted) setBusy(false); }
  }
  return <div className="fixed inset-0 z-[400] flex justify-end bg-[#22263124]" onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}>
    <section role="dialog" aria-modal="true" aria-labelledby="shell-provider-title"
      className="flex h-full w-[392px] max-w-full flex-col border-l border-[#E6EAF3] bg-white shadow-xl">
      <header className="flex h-16 items-center justify-between border-b border-[#E6EAF3] px-6">
        <div><h2 id="shell-provider-title" className="text-base font-semibold">{replacing ? '更换视图提供者' : '添加功能'}</h2>
          <p className="mt-1 text-xs text-[#596479]">{replacing ? '先验证新视图，成功后再替换' : '由插件提供完整视图，可重复添加'}</p></div>
        <button type="button" onClick={onClose} aria-label="关闭视图目录" className="rounded p-2 text-xl text-[#596479]">×</button>
      </header>
      <div className="border-b border-[#E6EAF3] px-6 py-4">
        <input autoFocus type="search" value={search} onChange={(event) => setSearch(event.currentTarget.value)}
          placeholder="搜索功能或插件" aria-label="搜索功能或插件" className="w-full rounded-lg border border-[#E6EAF3] px-3 py-2.5 text-sm outline-none focus:border-[#6C4CF5]" />
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-6 py-4">
        {views.map((view) => {
          const checked = selected?.pluginId === view.pluginId && selected.viewId === view.id;
          return <button type="button" key={`${view.pluginId}:${view.id}`}
            className={`w-full rounded-xl border p-4 text-left ${checked ? 'border-[#6C4CF5] bg-[#F5F2FF]' : 'border-[#E6EAF3] hover:bg-[#FAFBFE]'}`}
            aria-pressed={checked} onClick={() => setSelected({ pluginId: view.pluginId, viewId: view.id })}>
            <span className="block text-sm font-semibold text-[#222631]">{view.title}</span>
            <span className="mt-1.5 block break-all text-xs text-[#596479]">来自 {view.pluginId}</span>
            {view.provides.length > 0 && <span className="mt-2 block text-[10px] text-[#596479]">{view.provides.join(' · ')}</span>}
          </button>;
        })}
        {!views.length && <p className="rounded-xl border border-dashed border-[#E6EAF3] px-5 py-10 text-center text-sm leading-6 text-[#596479]">没有可添加的视图。请先启用提供界面功能的插件。</p>}
      </div>
      <footer className="space-y-4 border-t border-[#E6EAF3] p-6">
        {!replacing && <fieldset><legend className="mb-2 text-xs font-semibold">放置方式</legend>
          <div className="grid grid-cols-2 gap-2">{([
            ['split', '新建分栏'], ['tabs', '加入页签'], ['floating', '作为浮窗'], ['overlay', '作为覆盖层'],
          ] satisfies readonly (readonly [Placement, string])[]).map(([value, label]) =>
            <label key={value} className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${placement === value ? 'border-[#6C4CF5] bg-[#F5F2FF]' : 'border-[#E6EAF3]'}`}>
              <input type="radio" name="placement" value={value} checked={placement === value} onChange={() => setPlacement(value)} className="accent-[#6C4CF5]" />{label}
            </label>)}</div>
        </fieldset>}
        <p className="text-xs leading-6 text-[#596479]">{replacing ? '更换会关闭原视图。原视图尚未保存的内容不会自动迁移，准备失败时保持原视图。' : '同一功能可打开多个独立视图。覆盖层默认仅展示，界面挂载不会获得设备控制权。'}</p>
        {error && <p role="alert" className="rounded-lg bg-[#FFF4E7] px-3 py-2 text-xs leading-5 text-[#A65D0D]">{error}</p>}
        <button type="button" disabled={!selected || busy} onClick={() => { void submit(); }}
          className="w-full rounded-lg bg-[#6C4CF5] px-4 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40">
          {busy ? '正在准备视图…' : replacing ? '验证并更换' : '添加到工作区'}
        </button>
      </footer>
    </section>
  </div>;
}
