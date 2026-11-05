import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { HostContext } from '@deviceforge/plugin-sdk';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@deviceforge/business-kit/sheet';
import type { ShellController } from './controller.ts';
import type { MountPool } from './mount-pool.ts';
import { normalizeRoute } from './controller.ts';
import { instancesIn } from './layout.ts';
import { ViewFrame, LayoutNode, FloatingView } from './view.tsx';
import { ChromeAddons } from './addons.tsx';
import { StorageStatus } from './storage.tsx';
import { ShellHeader, ShellNavigation, ShellNavigationLinks, ShellStatus } from './chrome.tsx';
import { useShellConnection } from './connection.ts';
import { useShellFacts } from './use-facts.ts';
export function Shell({ context, controller, pool }: {
  readonly context: HostContext; readonly controller: ShellController; readonly pool: MountPool;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  const root = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState<boolean | null>(null);
  const [mobile, setMobile] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const [reduced, setReduced] = useState(false);
  const connection = useShellConnection(context);
  const facts = useShellFacts(context);
  const connectionState = connection.snapshot;
  useSyncExternalStore(pool.subscribe, pool.revision, pool.revision);
  useLayoutEffect(() => {
    const element = root.current, window = element?.ownerDocument.defaultView;
    if (!element || !window) return;
    const resize = () => {
      // 隐藏或尚未布局时保留密度，避免无尺寸观测触发视图切换。
      const width = element.clientWidth;
      if (width <= 0) return;
      controller.setCompact(width < 1100);
      setMobile(width <= 900);
      if (width > 900) setDrawerOpen(false);
    };
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
    const destination = controller.snapshot().route;
    if (window && normalizeRoute(window.location.hash) !== destination) window.location.hash = destination;
  }
  const page = state.current;
  const layout = page ? state.model.layouts.find((entry) => entry.workspaceId === page.workspaceId)?.layout : null;
  const ids = layout ? [...instancesIn(layout.root), ...layout.floating.map((view) => view.instanceId), ...layout.overlays.map((view) => view.instanceId)] : [];
  const compactContent = state.compact && state.compactView !== null;
  const viewProps = { state, controller, pool, editing: false, framed: false, onReplace: () => {}, onClose: () => {} };
  const cleanupErrors = pool.cleanupSnapshot();
  const compact = collapsed ?? state.compact;
  return <Sheet open={mobile && drawerOpen} onOpenChange={setDrawerOpen}>
  <div ref={root} data-navigation-collapsed={compact} data-navigation-mobile={mobile} data-focused={focused}
    className={`@container/default-shell grid h-full min-h-0 min-w-0 w-full grid-rows-[auto_minmax(0,1fr)_auto_auto] overflow-hidden bg-[#F5F6FB] text-[#222631] ${focused || mobile ? 'grid-cols-[0px_minmax(0,1fr)]' : compact ? 'grid-cols-[64px_minmax(0,1fr)]' : 'grid-cols-[236px_minmax(0,1fr)]'} ${reduced ? '[&_*]:animate-none [&_*]:transition-none' : ''}`}>
    {!mobile && <ShellNavigation state={state} compact={compact} hidden={focused} connection={connectionState} navigate={navigate}>
      <ChromeAddons context={context} region="sidebar" pool={pool} state={state} />
    </ShellNavigation>}
    <ShellHeader state={state} compact={compact} mobile={mobile} focused={focused} reduced={reduced} connection={connectionState}
      onCollapse={() => setCollapsed(!compact)} onFocus={() => setFocused((value) => !value)}
      onReduced={() => setReduced((value) => !value)} onRefresh={() => { void connection.refresh(); facts.refresh(); }} navigate={navigate}>
      <ChromeAddons context={context} region="header" pool={pool} state={state} />
    </ShellHeader>
    <main id="workplane" tabIndex={-1} data-product-workspace className="col-start-2 flex min-h-0 min-w-0 flex-col overflow-hidden">
      {page && !state.available && <p role="status" className="shrink-0 border-b border-[#F1D8B5] bg-[#FFF7EC] px-4 py-3 text-xs leading-6 text-[#A65D0D]">页面提供者当前不可用。已有草稿保留，其他独立功能仍可使用。</p>}
      {state.notice && <p role="status" className="shrink-0 px-4 py-2 text-xs text-[#596479]">{state.notice}</p>}
      {state.routeConflicts.length > 0 && <p role="alert" className="shrink-0 border-b border-[#F1D8B5] bg-[#FFF7EC] px-4 py-3 text-xs leading-6 text-[#A65D0D]">页面地址冲突：{state.routeConflicts.join('、')}。请在平台恢复入口核对提供者，已有草稿保留。</p>}
      {compactContent && ids.length > 1 && <div role="tablist" aria-label="当前页面功能" className="flex min-w-0 shrink-0 overflow-x-auto border-b border-[#E6EAF3] bg-white">
        {ids.map((id) => {
          const instance = state.model.instances.find((entry) => entry.instanceId === id);
          const title = state.model.catalog.views.find((entry) => entry.id === instance?.provider?.viewId)?.title ?? '等待插件';
          return <button type="button" role="tab" key={id} aria-selected={state.compactView === id} onClick={() => controller.selectCompact(id)}
            className={`shrink-0 border-b-2 px-4 py-2.5 text-xs ${state.compactView === id ? 'border-[#6C4CF5] font-semibold text-[#6C4CF5]' : 'border-transparent text-[#596479]'}`}>{title}</button>;
        })}
      </div>}
      <div data-workspace-canvas className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        {compactContent && state.compactView ? <ViewFrame {...viewProps} instanceId={state.compactView} />
          : layout?.root ? <LayoutNode {...viewProps} node={layout.root} path={[]} /> : <div className="flex h-full min-h-0 flex-col items-center justify-center gap-2 overflow-auto p-6 text-center">
            <h2 className="text-sm font-semibold">{page ? '插件尚未提供页面内容' : state.route !== '/' ? '当前页面暂不可用' : '暂无可用页面'}</h2>
            <p className="max-w-md text-xs leading-6 text-[#596479]">{!page && state.route !== '/'
              ? '页面所属插件可能仍在加载或尚未启用。可等待其就绪，或从导航进入其他页面。'
              : '启用提供相应功能的插件后，界面会自动显示，无需手动添加视图。'}</p>
          </div>}
        {!compactContent && layout?.floating.map((view) => <FloatingView {...viewProps} key={view.instanceId} view={view} overlay={false} />)}
        {!compactContent && layout?.overlays.map((view) => <FloatingView {...viewProps} key={view.instanceId} view={view} overlay />)}
      </div>
    </main>
    <div aria-label="任务与通知" className={`col-start-2 flex min-h-0 min-w-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-[#E6EAF3] bg-white text-[10px] text-[#596479] ${focused ? 'hidden' : 'px-3 py-1'}`}>
      <ChromeAddons context={context} region="footer" pool={pool} state={state} /><StorageStatus context={context} warningsOnly />
      {cleanupErrors.length > 0 && <span title={cleanupErrors.join('\n')} className="text-[#A65D0D]">资源回收记录 {cleanupErrors.length}</span>}
    </div>
    <ShellStatus state={state} connection={connectionState} facts={facts.snapshot} />
  </div>
  {mobile && <SheetContent side="left" className={`min-h-0 gap-0 text-[15px] text-foreground ${reduced ? 'animate-none transition-none [&_*]:animate-none [&_*]:transition-none' : ''}`}>
    <SheetHeader>
      <SheetTitle className="text-[17px]">工坊导航</SheetTitle>
      <SheetDescription>选择工具，继续当前设备工作</SheetDescription>
    </SheetHeader>
    <ShellNavigationLinks state={state} compact={false} drawer navigate={(route) => { navigate(route); setDrawerOpen(false); }}>
      <ChromeAddons context={context} region="sidebar" pool={pool} state={state} />
    </ShellNavigationLinks>
  </SheetContent>}
  </Sheet>;
}
