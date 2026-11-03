import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, PointerEvent } from 'react';
import type { WorkspaceFloatingView, WorkspaceOverlayView, WorkspaceLayoutNode } from '@deviceforge/plugin-sdk';
import type { ShellController, ShellState } from './controller.ts';
import type { MountPool } from './mount-pool.ts';
import type { Placement } from './layout.ts';
import { instancesIn } from './layout.ts';
import { floatingPosition } from './floating.ts';
import type { FloatingArea } from './floating.ts';

export interface ViewProps {
  readonly controller: ShellController;
  readonly pool: MountPool;
  readonly state: ShellState;
  readonly editing: boolean;
  readonly framed?: boolean;
  readonly onReplace: (instanceId: string) => void;
  readonly onClose: (instanceId: string) => void;
}
const placement = (value: string): value is Placement => ['split', 'tabs', 'floating', 'overlay'].includes(value);
export function ViewContent({ instanceId, pool, state }: Pick<ViewProps, 'pool' | 'state'> & { readonly instanceId: string }) {
  const target = useRef<HTMLDivElement>(null);
  const [retry, setRetry] = useState(0);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  useSyncExternalStore(pool.subscribe, pool.revision, pool.revision);
  const instance = state.model.instances.find((view) => view.instanceId === instanceId);
  const status = pool.status(instanceId);
  useLayoutEffect(() => {
    if (!target.current || instance?.state !== 'ready') return;
    try {
      const detach = pool.attach(instanceId, target.current);
      setAttachmentError(null);
      void pool.prepare(instanceId).catch(() => undefined);
      return () => { void detach(); };
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : '视图挂载入口暂时不可用');
    }
  }, [instanceId, instance?.generation, instance?.state, pool, retry]);
  const ready = instance?.state === 'ready' && status.state === 'ready' && !attachmentError;
  const failed = status.state === 'failed' || !!attachmentError;
  const stateLabel = instance?.state === 'ready'
    ? failed ? '视图暂时无法显示' : '正在打开视图'
    : instance?.reason === 'owner_inactive' ? '视图所属插件已停用' : '等待视图提供者';
  const detail = attachmentError ?? status.error ?? '布局位置已保留。启用对应插件后可重新打开，不会自动重放任务或写入。';
  return <div className="relative h-full min-h-0 min-w-0">
    <div ref={target} className={ready ? 'h-full min-h-0 min-w-0 overflow-auto' : 'absolute inset-0 opacity-0 pointer-events-none'} />
    {!ready && <div className="flex h-full min-h-0 flex-col items-center gap-3 overflow-y-auto px-6 py-6 text-center">
      <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#F2EFFF] text-lg text-[#6C4CF5]" aria-hidden="true">◇</span>
      <p role={failed ? 'alert' : 'status'} aria-label={stateLabel}
        className="text-sm font-semibold text-[#222631]">{stateLabel}</p>
      <p role="note" aria-label={`视图技术详情：${detail}`}
        className="max-w-sm break-words text-xs leading-6 text-[#596479]">{detail}</p>
      {instance?.state === 'ready' && failed && <button type="button"
        aria-label="重新打开视图"
        className="rounded-lg border border-[#E6EAF3] bg-white px-3 py-2 text-xs text-[#6C4CF5]"
        onClick={() => { void pool.drop(instanceId).then(() => setRetry((value) => value + 1)); }}>重新打开视图</button>}
    </div>}
  </div>;
}
export function ViewFrame(props: ViewProps & { readonly instanceId: string; readonly overlay?: boolean }) {
  const { state, instanceId, controller, editing, onClose, onReplace, overlay } = props;
  const actions = useRef<HTMLDetailsElement>(null);
  const instance = state.model.instances.find((view) => view.instanceId === instanceId);
  const view = state.model.catalog.views.find((entry) => entry.id === instance?.provider?.viewId && entry.pluginId === instance.provider.pluginId);
  if (props.framed === false) {
    return <section data-shell-instance={instanceId} className="h-full min-h-0 min-w-0 overflow-hidden">
      <ViewContent key={instanceId} instanceId={instanceId} pool={props.pool} state={state} />
    </section>;
  }
  function closeActions() {
    if (actions.current) actions.current.open = false;
    actions.current?.querySelector('summary')?.focus();
  }
  return <section data-shell-instance={instanceId} className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-[#E6EAF3] bg-white shadow-[0_2px_8px_#25324D05]">
    <header className="flex min-h-11 min-w-0 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2 text-xs">
      <span className="min-w-0 max-w-[45%] truncate font-semibold">{view?.title ?? instance?.provider?.viewId ?? '尚未选择视图'}</span>
      <span aria-label="视图来源" title={`来源：${instance?.provider?.pluginId ?? '未选择提供者'}`} className="min-w-0 flex-1 truncate text-[10px] text-[#596479]">{instance?.provider?.pluginId ?? '未选择提供者'}</span>
      {overlay && <span className="text-[10px] text-[#596479]">覆盖层</span>}
      {instance?.state === 'missing' && <span className="shrink-0 text-[10px] text-[#A65D0D]" title="插件不可用，布局与位置保留">插件不可用</span>}
      <details ref={actions} className="relative shrink-0" onKeyDown={(event) => {
        if (event.key === 'Escape' && event.currentTarget.open) {
          event.preventDefault(); event.stopPropagation(); closeActions();
        }
      }}>
        <summary aria-label={`${view?.title ?? '视图'}更多操作`} className="flex h-7 w-7 cursor-pointer list-none items-center justify-center rounded text-base text-[#596479] hover:bg-[#F5F6FB]">⋯</summary>
        <div className="absolute right-0 top-8 z-[120] w-40 rounded-lg border border-[#E6EAF3] bg-white p-1 shadow-lg">
          <button type="button" onClick={() => { closeActions(); onReplace(instanceId); }} className="w-full rounded px-3 py-2 text-left text-xs text-[#6C4CF5]" aria-label={`更换${view?.title ?? '视图'}提供者`}>更换提供者</button>
          <button type="button" onClick={() => { closeActions(); onClose(instanceId); }} className="w-full rounded px-3 py-2 text-left text-xs text-[#596479]" aria-label={`关闭${view?.title ?? '视图'}`}>关闭视图</button>
        </div>
      </details>
    </header>
    {editing && <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[#E6EAF3] bg-[#FAFBFE] px-3 py-2 text-xs">
      <label className="flex items-center gap-1 text-[#596479]">停靠到
        <select aria-label="视图停靠方式" defaultValue="" className="rounded border border-[#E6EAF3] bg-white px-2 py-1"
          onChange={(event) => { if (placement(event.currentTarget.value)) controller.place(instanceId, event.currentTarget.value); }}>
          <option value="" disabled>选择位置</option><option value="split">分栏</option><option value="tabs">页签</option>
          <option value="floating">浮窗</option><option value="overlay">覆盖层</option>
        </select>
      </label>
      <button type="button" className="rounded border border-[#E6EAF3] px-2 py-1" onClick={() => controller.reorder(instanceId, -1)} aria-label="视图前移">←</button>
      <button type="button" className="rounded border border-[#E6EAF3] px-2 py-1" onClick={() => controller.reorder(instanceId, 1)} aria-label="视图后移">→</button>
    </div>}
    <div className="min-h-0 min-w-0 flex-1 overflow-auto"><ViewContent key={instanceId} instanceId={instanceId} pool={props.pool} state={state} /></div>
  </section>;
}
interface Geometry extends CSSProperties {
  '--shell-cols'?: string; '--shell-rows'?: string;
  '--shell-x'?: string; '--shell-y'?: string; '--shell-w'?: string; '--shell-h'?: string; '--shell-z'?: number;
}
export function LayoutNode(props: ViewProps & { readonly node: WorkspaceLayoutNode; readonly path: readonly number[] }) {
  const { node, path, controller, editing, state } = props;
  if (node.kind === 'view') return <ViewFrame {...props} instanceId={node.instanceId} />;
  if (node.kind === 'custom') return <CustomLayout {...props} node={node} />;
  if (node.kind === 'tabs') {
    const active = node.items.find((item) => item.id === node.active) ?? node.items[0];
    // 单项只是保留的组合层；没有切换对象时直接呈现业务，路径仍按原布局寻址。
    if (node.items.length === 1 && active) return <LayoutNode {...props} node={active.node} path={[...path, 0]} />;
    return <section className="flex h-full min-h-0 min-w-0 flex-col">
      <div role="tablist" aria-label="工作区视图页签" className="mb-3 flex min-w-0 shrink-0 gap-1 overflow-x-auto border-b border-[#E6EAF3]">
        {node.items.map((item) => <button role="tab" aria-selected={item === active} type="button" key={item.id}
          className={`shrink-0 border-b-2 px-4 py-2.5 text-xs ${item === active ? 'border-[#6C4CF5] font-semibold text-[#6C4CF5]' : 'border-transparent text-[#596479]'}`}
          onClick={() => controller.selectTab(path, item.id)}>{item.title ?? titleFor(instancesIn(item.node)[0], state)}</button>)}
      </div>
      {active && <div className="min-h-0 min-w-0 flex-1"><LayoutNode {...props} node={active.node} path={[...path, node.items.indexOf(active)]} /></div>}
    </section>;
  }
  const values = node.children.map((_child, at) => `minmax(0,${node.weights[at] ?? 1}fr)`).join(' ');
  const style: Geometry = node.direction === 'horizontal' ? { '--shell-cols': values } : { '--shell-rows': values };
  return <section className="flex h-full min-h-0 min-w-0 flex-col">
    {editing && <label className="mb-2 flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-3 text-[11px] text-[#596479]">
      {node.direction === 'horizontal' ? '第一分栏宽度' : '第一分栏高度'}
      <input type="range" min="15" max="85" value={Math.round((node.weights[0] ?? 0.5) * 100)} aria-label="调整分栏比例"
        onChange={(event) => controller.resizeSplit(path, Number(event.currentTarget.value) / 100)} className="w-28 accent-[#6C4CF5]" />
    </label>}
    <div className={`grid min-h-0 min-w-0 flex-1 ${props.framed === false ? 'gap-0' : 'gap-4'} ${node.direction === 'horizontal' ? 'grid-cols-[var(--shell-cols)]' : 'grid-rows-[var(--shell-rows)]'}`} style={style}>
      {node.children.map((child, at) => <LayoutNode {...props} key={`${path.join('.')}.${at}`} node={child} path={[...path, at]} />)}
    </div>
  </section>;
}
function titleFor(instanceId: string | undefined, state: ShellState) {
  const instance = state.model.instances.find((entry) => entry.instanceId === instanceId);
  return state.model.catalog.views.find((entry) => entry.id === instance?.provider?.viewId)?.title ?? '视图';
}
function CustomLayout(props: ViewProps & { readonly node: Extract<WorkspaceLayoutNode, { kind: 'custom' }>; readonly path: readonly number[] }) {
  const [id, setId] = useState<string | null>(null);
  const workspaceId = props.state.current?.workspaceId;
  useLayoutEffect(() => {
    if (workspaceId) setId(props.controller.ensureCustom(workspaceId, props.path.join('.'), props.node));
  }, [workspaceId, props.controller, props.node, props.path.join('.')]);
  return id ? <ViewFrame {...props} instanceId={id} /> : <p className="rounded-xl border border-[#E6EAF3] bg-white p-6 text-sm text-[#596479]">正在准备自定义布局提供者</p>;
}
export function FloatingView(props: ViewProps & { readonly view: WorkspaceFloatingView | WorkspaceOverlayView; readonly overlay: boolean }) {
  const { view, controller, overlay } = props;
  const relativeTo = overlay && 'relativeTo' in view ? view.relativeTo : undefined;
  const [interactive, setInteractive] = useState(false);
  const [area, setArea] = useState<FloatingArea>({ x: 0, y: 0, width: 1200, height: 800 });
  const [anchorMissing, setAnchorMissing] = useState(!!relativeTo);
  const container = useRef<HTMLElement>(null), interactionButton = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const element = container.current;
    const canvas = element?.closest('[data-workspace-canvas]');
    const window = element?.ownerDocument.defaultView;
    if (!element || !canvas || !window) return;
    const anchor = relativeTo ? [...canvas.querySelectorAll<HTMLElement>('[data-shell-instance]')]
      .find((candidate) => candidate.dataset.shellInstance === relativeTo && !element.contains(candidate)) : canvas;
    setAnchorMissing(!!relativeTo && !anchor);
    if (!anchor) { setInteractive(false); return; }
    const measure = () => {
      const bounds = anchor.getBoundingClientRect(), canvasBounds = canvas.getBoundingClientRect();
      if (relativeTo && (bounds.width <= 0 || bounds.height <= 0)) {
        setAnchorMissing(true);
        setInteractive(false);
        return;
      }
      setAnchorMissing(false);
      const next = {
        x: relativeTo ? bounds.left - canvasBounds.left + canvas.scrollLeft : 0,
        y: relativeTo ? bounds.top - canvasBounds.top + canvas.scrollTop : 0,
        width: bounds.width || canvas.clientWidth || 1200,
        height: bounds.height || canvas.clientHeight || 800,
      };
      setArea((previous) => previous.x === next.x && previous.y === next.y &&
        previous.width === next.width && previous.height === next.height ? previous : next);
    };
    measure();
    const observer = window.ResizeObserver ? new window.ResizeObserver(measure) : null;
    observer?.observe(canvas);
    if (anchor !== canvas) observer?.observe(anchor);
    window.addEventListener('resize', measure);
    canvas.addEventListener('scroll', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); canvas.removeEventListener('scroll', measure); };
  }, [relativeTo, props.state.model.revision]);
  const position = floatingPosition(view, area);
  const drag = useRef<{ x: number; y: number; view: WorkspaceFloatingView; resize: boolean } | null>(null);
  const style: Geometry = {
    '--shell-x': `${position.left}px`, '--shell-y': `${position.top}px`, '--shell-w': `${position.width}px`,
    '--shell-h': `${position.height}px`, '--shell-z': view.z + (overlay ? 100 : 10),
  };
  function start(event: PointerEvent<HTMLButtonElement>, resize: boolean) {
    drag.current = { x: event.clientX, y: event.clientY, view: { ...view, ...position }, resize };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent<HTMLButtonElement>) {
    const value = drag.current;
    if (!value) return;
    const width = area.width, height = area.height;
    const dx = event.clientX - value.x, dy = event.clientY - value.y;
    controller.float(view.instanceId, value.resize
      ? { width: Math.min(width - value.view.x, value.view.width + dx), height: Math.min(height - value.view.y, value.view.height + dy) }
      : { x: Math.min(Math.max(0, width - 120), value.view.x + dx), y: Math.min(Math.max(0, height - 80), value.view.y + dy) });
  }
  function stop(event: PointerEvent<HTMLButtonElement>) {
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  return <section ref={container} style={style} className={`absolute left-[var(--shell-x)] top-[var(--shell-y)] z-[var(--shell-z)] flex min-h-0 min-w-0 h-[var(--shell-h)] max-h-full w-[var(--shell-w)] max-w-full flex-col rounded-xl border border-[#CEC4FF] bg-white shadow-xl ${overlay ? 'pointer-events-none' : ''}`}
    onKeyDown={(event) => { if (event.key === 'Escape') { setInteractive(false); drag.current = null; interactionButton.current?.focus(); } }}>
    <div className={`pointer-events-auto min-w-0 shrink-0 flex-wrap items-center gap-2 rounded-t-xl bg-[#F2EFFF] px-3 py-2 text-xs ${props.framed === false && !overlay ? 'hidden' : 'flex'}`}>
      <button type="button" className={`min-w-0 flex-1 cursor-move touch-none truncate text-left font-semibold text-[#6C4CF5] ${props.framed === false ? 'hidden' : ''}`}
        onPointerDown={(event) => start(event, false)} onPointerMove={move} onPointerUp={stop} onPointerCancel={stop}
        onKeyDown={(event) => {
          const delta = event.shiftKey ? 1 : 10;
          if (event.key === 'ArrowLeft') controller.float(view.instanceId, { x: position.x - delta });
          else if (event.key === 'ArrowRight') controller.float(view.instanceId, { x: position.x + delta });
          else if (event.key === 'ArrowUp') controller.float(view.instanceId, { y: position.y - delta });
          else if (event.key === 'ArrowDown') controller.float(view.instanceId, { y: position.y + delta });
          else return;
          event.preventDefault();
        }} aria-label={`移动${overlay ? '覆盖层' : '浮窗'}，方向键调整位置`}>⠿ {overlay ? '覆盖层 · 默认只显示' : '浮动视图 · 拖动标题栏'}</button>
      {overlay && <button ref={interactionButton} type="button" disabled={anchorMissing} onClick={() => setInteractive((value) => !value)} className="rounded bg-white px-2 py-1 text-[#6C4CF5] disabled:opacity-40">{interactive ? '结束交互' : '启用交互'}</button>}
      {props.framed !== false && <button type="button" onClick={() => props.onClose(view.instanceId)} aria-label={`关闭${overlay ? '覆盖层' : '浮窗'}`} className="rounded px-1 text-base text-[#596479]">×</button>}
    </div>
    <div className={`min-h-0 flex-1 overflow-auto ${overlay && (!interactive || anchorMissing) ? 'pointer-events-none' : 'pointer-events-auto'}`} inert={overlay && (!interactive || anchorMissing)}>
      {anchorMissing ? <p role="status" className="p-5 text-xs leading-6 text-[#A65D0D]">覆盖层锚点暂不可用，位置已保留。请先显示对应视图。</p>
        : <ViewFrame {...props} instanceId={view.instanceId} />}
    </div>
    {props.framed !== false && <button type="button" className="pointer-events-auto absolute bottom-1 right-1 h-5 w-5 cursor-se-resize touch-none rounded bg-[#F2EFFF] text-xs text-[#6C4CF5]"
      aria-label="缩放浮动视图，方向键调整尺寸" onPointerDown={(event) => start(event, true)} onPointerMove={move} onPointerUp={stop} onPointerCancel={stop}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') controller.float(view.instanceId, { width: position.width - 10 });
        else if (event.key === 'ArrowRight') controller.float(view.instanceId, { width: position.width + 10 });
        else if (event.key === 'ArrowUp') controller.float(view.instanceId, { height: position.height - 10 });
        else if (event.key === 'ArrowDown') controller.float(view.instanceId, { height: position.height + 10 });
        else return;
        event.preventDefault();
      }}>⌟</button>}
  </section>;
}
