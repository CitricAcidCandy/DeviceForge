import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { HostContext } from '@deviceforge/plugin-sdk';
import type { ShellController } from './controller.ts';
import type { MountPool } from './mount-pool.ts';
import { normalizeRoute } from './controller.ts';
import { instancesIn } from './layout.ts';
import { ViewFrame, LayoutNode, FloatingView } from './view.tsx';
import { ProviderPicker } from './picker.tsx';
import { ChromeAddons } from './addons.tsx';
import { StorageStatus } from './storage.tsx';

function NavigationIcon({ name }: { readonly name: string | undefined }) {
  const paths: Readonly<Record<string, string>> = {
    Smartphone: 'M8 2h8v20H8z M11 18h2', FolderOpen: 'M2 6h8l2 3h10l-3 11H2z M2 6V4h8l2 2',
    Activity: 'M2 12h5l3-8 4 16 3-8h5', Code2: 'm8 5-6 7 6 7 M16 5l6 7-6 7',
    Workflow: 'M3 3h6v6H3z M15 15h6v6h-6z M6 9v9h9 M15 3h6v6h-6z M9 6h6',
    Terminal: 'm3 5 6 7-6 7 M12 19h9', Sparkles: 'm12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3z',
    ScanSearch: 'M3 8V3h5 M16 3h5v5 M3 16v5h5 M16 21h5v-5 M14 14l4 4 M8 11a4 4 0 1 0 8 0a4 4 0 1 0-8 0',
    ListChecks: 'm2 6 2 2 4-4 M11 6h11 m-20 8 2 2 4-4 M11 14h11 M11 21h11',
    Store: 'M3 9h18v13H3z M2 9l3-7h14l3 7 M9 22v-8h6v8',
    Settings2: 'M3 6h18 M3 18h18 M8 3v6 M16 15v6',
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4 shrink-0" aria-hidden="true">
    <path d={paths[name ?? ''] ?? 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z'} strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}
export function Shell({ context, controller, pool }: {
  readonly context: HostContext; readonly controller: ShellController; readonly pool: MountPool;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  const root = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const [picker, setPicker] = useState<{ replacing: string | null } | null>(null);
  const [closing, setClosing] = useState<string | null>(null);
  const [shellPicker, setShellPicker] = useState(false);
  useSyncExternalStore(pool.subscribe, pool.revision, pool.revision);
  useLayoutEffect(() => {
    const element = root.current, window = element?.ownerDocument.defaultView;
    if (!element || !window) return;
    const resize = () => controller.setCompact(element.clientWidth > 0 && element.clientWidth < 1100);
    resize();
    const observer = window.ResizeObserver ? new window.ResizeObserver(resize) : null;
    observer?.observe(element);
    window.addEventListener('resize', resize);
    return () => { observer?.disconnect(); window.removeEventListener('resize', resize); };
  }, [controller]);
  useEffect(() => {
    const window = root.current?.ownerDocument.defaultView;
    if (!window) return;
    const changed = () => controller.navigate(window.location.hash);
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, [controller]);
  function navigate(route: string) {
    controller.navigate(route);
    const window = root.current?.ownerDocument.defaultView;
    if (window && normalizeRoute(window.location.hash) !== normalizeRoute(route)) window.location.hash = normalizeRoute(route);
  }
  const groups = [...new Set(state.pages.filter((page) => !page.navigation?.hidden).map((page) => page.navigation?.group ?? '插件工作区'))];
  const page = state.current;
  const layout = page ? state.model.layouts.find((entry) => entry.workspaceId === page.workspaceId)?.layout : null;
  const ids = layout ? [...instancesIn(layout.root), ...layout.floating.map((view) => view.instanceId), ...layout.overlays.map((view) => view.instanceId)] : [];
  const viewProps = { state, controller, pool, editing, onReplace: (id: string) => setPicker({ replacing: id }), onClose: setClosing };
  const cleanupErrors = pool.cleanupSnapshot();
  const shellPoint = { id: 'host.shell', version: '1' };
  const shellChoices = context.extensions?.points?.list(shellPoint).filter((entry) => entry.state === 'active' && entry.mode === 'replace') ?? [];
  return <div ref={root} className="grid h-full min-h-0 w-full grid-cols-[184px_minmax(0,1fr)] grid-rows-[56px_minmax(0,1fr)_48px] bg-[#F5F6FB] text-[#222631] max-[1100px]:grid-cols-[72px_minmax(0,1fr)]">
    <aside className="row-span-3 flex min-h-0 flex-col border-r border-[#E6EAF3] bg-white">
      <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-[#E6EAF3] px-5 max-[1100px]:justify-center max-[1100px]:px-0">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#6C4CF5] text-lg font-semibold text-white">F</span>
        <div className="max-[1100px]:hidden"><p className="text-sm font-bold tracking-wide">FORGE</p><p className="text-[10px] text-[#596479]">设备工坊 DeviceForge</p></div>
      </div>
      <nav aria-label="工作区导航" className="min-h-0 flex-1 space-y-6 overflow-y-auto px-3 py-6 max-[1100px]:px-2">
        {groups.map((group) => <div key={group}>
          <h2 className="mb-2 px-2 text-[10px] font-semibold tracking-wide text-[#8790A2] max-[1100px]:sr-only">{group}</h2>
          <div className="space-y-1">{state.pages.filter((entry) => !entry.navigation?.hidden && (entry.navigation?.group ?? '插件工作区') === group).map((entry) =>
            <button type="button" key={entry.id} title={`${entry.title} · ${entry.pluginId}`} aria-current={normalizeRoute(entry.route) === state.route ? 'page' : undefined}
              className={`flex min-h-10 w-full items-center gap-2.5 rounded-lg px-3 text-left text-xs max-[1100px]:justify-center max-[1100px]:px-0 ${normalizeRoute(entry.route) === state.route ? 'bg-[#F0EBFF] font-semibold text-[#6C4CF5]' : 'text-[#596479] hover:bg-[#F7F8FC]'}`}
              onClick={() => navigate(entry.route)}><NavigationIcon name={entry.navigation?.icon} /><span className="truncate max-[1100px]:sr-only">{entry.title}</span></button>)}</div>
        </div>)}
        <ChromeAddons context={context} region="sidebar" pool={pool} state={state} />
      </nav>
      <div className="shrink-0 border-t border-[#E6EAF3] p-4 text-[10px] leading-5 text-[#8790A2] max-[1100px]:p-2 max-[1100px]:text-center">
        <span className="max-[1100px]:hidden">默认工作区<br />来自 </span><span title="deviceforge_shell">官方插件</span>
      </div>
    </aside>
    <header className="flex min-w-0 items-center justify-between gap-3 border-b border-[#E6EAF3] bg-white px-6 max-[1100px]:px-4">
      <div className="flex min-w-0 items-center gap-2 text-xs"><span className="text-[#8790A2]">工作台</span><span className="text-[#BAC0CC]">›</span>
        <span className="truncate font-semibold">{page?.page.title ?? '选择工作区'}</span></div>
      <div className="flex shrink-0 items-center gap-2"><ChromeAddons context={context} region="header" pool={pool} state={state} />
        <button type="button" onClick={() => setPicker({ replacing: null })} disabled={!page} className="rounded-lg bg-[#6C4CF5] px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">＋ 添加功能</button>
        <button type="button" aria-pressed={editing} onClick={() => setEditing((value) => !value)} className="rounded-lg border border-[#E6EAF3] px-3 py-2 text-xs text-[#596479]">{editing ? '完成编辑' : '编辑布局'}</button>
      </div>
    </header>
    <main className="min-h-0 min-w-0 overflow-auto px-6 py-5 max-[1100px]:px-4">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div className="min-w-0"><h1 className="text-lg font-semibold">{page?.page.title ?? '工作区'}</h1>
          <p className="mt-1.5 text-xs leading-5 text-[#596479]">{page?.page.navigation?.description ?? '由插件组合功能，按自己的工作方式安排视图。'}</p></div>
        {page && <span className="shrink-0 rounded-full border border-[#E6EAF3] bg-white px-3 py-1.5 text-[10px] text-[#596479]">页面来自 {page.page.pluginId}</span>}
      </div>
      {editing && <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-[#DCD3FF] bg-[#F5F2FF] px-4 py-3 text-xs text-[#6C4CF5]">
        <p>布局编辑中 · 在视图标题栏选择停靠方式、调整顺序与分栏比例。</p><button type="button" className="shrink-0 rounded-lg bg-white px-3 py-2" onClick={() => setEditing(false)}>完成</button>
      </div>}
      {page && !state.available && <p role="status" className="mb-4 rounded-xl border border-[#F1D8B5] bg-[#FFF7EC] px-4 py-3 text-xs leading-6 text-[#A65D0D]">页面提供者当前不可用。布局与已打开草稿保留，其他独立视图仍可使用。</p>}
      {state.notice && <p role="status" className="mb-3 text-xs text-[#596479]">{state.notice}</p>}
      {state.compact && ids.length > 0 && <div role="tablist" aria-label="窄窗工作区视图" className="mb-4 flex gap-2 overflow-x-auto">
        {ids.map((id) => {
          const instance = state.model.instances.find((entry) => entry.instanceId === id);
          const title = state.model.catalog.views.find((entry) => entry.id === instance?.provider?.viewId)?.title ?? instance?.provider?.viewId ?? '缺失视图';
          return <button type="button" role="tab" key={id} aria-selected={state.compactView === id} onClick={() => controller.selectCompact(id)}
            className={`shrink-0 rounded-lg border px-4 py-2.5 text-xs ${state.compactView === id ? 'border-[#6C4CF5] bg-[#F0EBFF] text-[#6C4CF5]' : 'border-[#E6EAF3] bg-white text-[#596479]'}`}>{title}</button>;
        })}
      </div>}
      <div data-workspace-canvas className="relative min-h-[520px] min-w-0">
        {state.compact && state.compactView ? <ViewFrame {...viewProps} instanceId={state.compactView} />
          : layout?.root ? <LayoutNode {...viewProps} node={layout.root} path={[]} /> : <div className="flex min-h-[400px] flex-col items-center justify-center rounded-xl border border-dashed border-[#D8DEEB] bg-white p-8 text-center">
            <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-[#F0EBFF] text-2xl text-[#6C4CF5]">＋</span>
            <h2 className="text-base font-semibold">{page ? '这个工作区还没有视图' : '暂无可用工作区'}</h2>
            <p className="mt-2 max-w-md text-xs leading-6 text-[#596479]">{page ? '从已启用的插件添加功能。分栏、页签与浮窗都可按需要组合。' : '启用提供页面的插件后，导航会自动出现。已有布局不会被删除。'}</p>
            {page && <button type="button" onClick={() => setPicker({ replacing: null })} className="mt-5 rounded-lg bg-[#6C4CF5] px-5 py-2.5 text-xs text-white">添加第一个功能</button>}
          </div>}
        {!state.compact && layout?.floating.map((view) => <FloatingView {...viewProps} key={view.instanceId} view={view} overlay={false} />)}
        {!state.compact && layout?.overlays.map((view) => <FloatingView {...viewProps} key={view.instanceId} view={view} overlay />)}
      </div>
    </main>
    <footer className="flex min-w-0 items-center justify-between gap-3 border-t border-[#E6EAF3] bg-white px-6 text-[10px] text-[#596479] max-[1100px]:px-4">
      <div className="flex min-w-0 items-center gap-4"><span className="shrink-0">已发现 {state.pages.length} 个页面 · {ids.length} 个视图</span>
        <StorageStatus context={context} /><ChromeAddons context={context} region="footer" pool={pool} state={state} />
        {cleanupErrors.length > 0 && <span title={cleanupErrors.join('\n')} className="text-[#A65D0D]">资源回收记录 {cleanupErrors.length}</span>}</div>
      <div className="flex shrink-0 items-center gap-3"><button type="button" onClick={() => setShellPicker(true)}>更换外壳</button>
        <button type="button" className="text-[#6C4CF5]" onClick={() => context.extensions?.points?.select(shellPoint, null)}>平台恢复</button></div>
    </footer>
    {picker && <ProviderPicker state={state} controller={controller} replacing={picker.replacing} onClose={() => setPicker(null)} />}
    {closing && <div className="fixed inset-0 z-[410] flex items-center justify-center bg-[#22263130] p-6"><section role="alertdialog" aria-modal="true" aria-labelledby="shell-close-title" className="w-full max-w-sm rounded-2xl border border-[#E6EAF3] bg-white p-6 shadow-xl">
      <h2 id="shell-close-title" className="text-base font-semibold">关闭这个视图？</h2><p className="mt-3 text-xs leading-6 text-[#596479]">该视图中尚未保存的草稿可能丢失。关闭视图不会卸载插件。</p>
      <div className="mt-5 flex justify-end gap-2"><button type="button" className="rounded-lg border border-[#E6EAF3] px-4 py-2 text-xs" onClick={() => setClosing(null)}>保留视图</button>
        <button type="button" className="rounded-lg bg-[#6C4CF5] px-4 py-2 text-xs text-white" onClick={() => { controller.close(closing); setClosing(null); }}>关闭视图</button></div>
    </section></div>}
    {shellPicker && <div className="fixed inset-0 z-[410] flex items-center justify-center bg-[#22263130] p-6"><section role="dialog" aria-modal="true" aria-labelledby="shell-choice-title" className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
      <h2 id="shell-choice-title" className="text-base font-semibold">选择工作区外壳</h2><p className="mt-2 text-xs leading-6 text-[#596479]">明确选择提供者。切换后仍保留业务布局，失败时使用平台恢复入口。</p>
      <div className="my-4 space-y-2">{shellChoices.map((choice) => <button type="button" key={choice.id} className="w-full rounded-xl border border-[#E6EAF3] p-3 text-left text-xs"
        onClick={() => { context.extensions?.points?.select(shellPoint, choice.id); setShellPicker(false); }}>{choice.provider.pluginId}{choice.selected ? ' · 当前使用' : ''}</button>)}</div>
      <button type="button" className="rounded-lg border border-[#E6EAF3] px-4 py-2 text-xs" onClick={() => setShellPicker(false)}>取消</button>
    </section></div>}
  </div>;
}
