import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, PointerEvent } from 'react';
import type { WorkspaceFloatingView, WorkspaceLayoutNode } from '@deviceforge/plugin-sdk';
import type { ShellController, ShellState } from './controller.ts';
import type { MountPool } from './mount-pool.ts';
import type { Placement } from './layout.ts';
import { instancesIn } from './layout.ts';

export interface ViewProps {
  readonly controller: ShellController;
  readonly pool: MountPool;
  readonly state: ShellState;
  readonly editing: boolean;
  readonly onReplace: (instanceId: string) => void;
  readonly onClose: (instanceId: string) => void;
}
const placement = (value: string): value is Placement => ['split', 'tabs', 'floating', 'overlay'].includes(value);
export function ViewContent({ instanceId, pool, state }: Pick<ViewProps, 'pool' | 'state'> & { readonly instanceId: string }) {
  const target = useRef<HTMLDivElement>(null);
  const [retry, setRetry] = useState(0);
  useSyncExternalStore(pool.subscribe, pool.revision, pool.revision);
  const instance = state.model.instances.find((view) => view.instanceId === instanceId);
  const status = pool.status(instanceId);
  useLayoutEffect(() => {
    if (!target.current || instance?.state !== 'ready') return;
    const detach = pool.attach(instanceId, target.current);
    void pool.prepare(instanceId).catch(() => undefined);
    return () => { void detach(); };
  }, [instanceId, instance?.generation, instance?.state, pool, retry]);
  return <div className="relative h-full min-h-[200px] min-w-0">
    <div ref={target} className={status.state === 'ready' ? 'h-full min-h-[200px]' : 'absolute inset-0 opacity-0 pointer-events-none'} />
    {status.state !== 'ready' && <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#F2EFFF] text-lg text-[#6C4CF5]" aria-hidden="true">◇</span>
      <p className="text-sm font-semibold text-[#222631]">{instance?.state === 'ready'
        ? status.state === 'failed' ? '视图暂时无法显示' : '正在打开视图'
        : instance?.reason === 'owner_inactive' ? '视图所属插件已停用' : '等待视图提供者'}</p>
      <p className="max-w-sm text-xs leading-6 text-[#596479]">{status.error ?? '布局位置已保留。启用对应插件后可重新打开，不会自动重放任务或写入。'}</p>
      {instance?.state === 'ready' && status.state === 'failed' && <button type="button"
        className="rounded-lg border border-[#E6EAF3] bg-white px-3 py-2 text-xs text-[#6C4CF5]"
        onClick={() => { void pool.drop(instanceId).then(() => setRetry((value) => value + 1)); }}>重新打开视图</button>}
    </div>}
  </div>;
}
export function ViewFrame(props: ViewProps & { readonly instanceId: string; readonly overlay?: boolean }) {
  const { state, instanceId, controller, editing, onClose, onReplace, overlay } = props;
  const instance = state.model.instances.find((view) => view.instanceId === instanceId);
  const view = state.model.catalog.views.find((entry) => entry.id === instance?.provider?.viewId && entry.pluginId === instance.provider.pluginId);
  return <section className="flex h-full min-h-[280px] min-w-0 flex-col overflow-hidden rounded-xl border border-[#E6EAF3] bg-white shadow-[0_2px_8px_#25324D05]">
    <header className="flex min-h-11 shrink-0 items-center gap-2 border-b border-[#E6EAF3] px-3 py-2">
      <span className="h-1.5 w-1.5 rounded-full bg-[#6C4CF5]" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-sm font-semibold">{view?.title ?? instance?.provider?.viewId ?? '尚未选择视图'}</span>
      {overlay && <span className="text-[10px] text-[#596479]">覆盖层</span>}
      <button type="button" onClick={() => onReplace(instanceId)} className="rounded px-1.5 py-1 text-xs text-[#6C4CF5]" aria-label={`更换${view?.title ?? '视图'}提供者`}>更换</button>
      <button type="button" onClick={() => onClose(instanceId)} className="rounded px-1.5 py-1 text-sm text-[#596479]" aria-label={`关闭${view?.title ?? '视图'}`}>×</button>
    </header>
    <div className="flex shrink-0 items-center gap-2 border-b border-[#F1F3F8] px-3 py-1.5 text-[10px] text-[#596479]">
      <span className="truncate">来自 {instance?.provider?.pluginId ?? '未选择提供者'}</span>
      {instance?.state === 'missing' && <span className="ml-auto shrink-0 text-[#A65D0D]">插件不可用 · 布局保留</span>}
    </div>
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
    <div className="min-h-0 flex-1"><ViewContent instanceId={instanceId} pool={props.pool} state={state} /></div>
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
    return <section className="min-h-0 min-w-0">
      <div role="tablist" aria-label="工作区视图页签" className="mb-3 flex gap-1 overflow-x-auto border-b border-[#E6EAF3]">
        {node.items.map((item) => <button role="tab" aria-selected={item === active} type="button" key={item.id}
          className={`shrink-0 border-b-2 px-4 py-2.5 text-xs ${item === active ? 'border-[#6C4CF5] font-semibold text-[#6C4CF5]' : 'border-transparent text-[#596479]'}`}
          onClick={() => controller.selectTab(path, item.id)}>{item.title ?? titleFor(instancesIn(item.node)[0], state)}</button>)}
      </div>
      {active && <LayoutNode {...props} node={active.node} path={[...path, node.items.indexOf(active)]} />}
    </section>;
  }
  const values = node.children.map((_child, at) => `minmax(0,${node.weights[at] ?? 1}fr)`).join(' ');
  const style: Geometry = node.direction === 'horizontal' ? { '--shell-cols': values } : { '--shell-rows': values };
  return <section className="min-h-0 min-w-0">
    {editing && <label className="mb-2 flex items-center justify-end gap-3 text-[11px] text-[#596479]">
      {node.direction === 'horizontal' ? '第一分栏宽度' : '第一分栏高度'}
      <input type="range" min="15" max="85" value={Math.round((node.weights[0] ?? 0.5) * 100)} aria-label="调整分栏比例"
        onChange={(event) => controller.resizeSplit(path, Number(event.currentTarget.value) / 100)} className="w-28 accent-[#6C4CF5]" />
    </label>}
    <div className={`grid min-h-0 gap-4 ${node.direction === 'horizontal' ? 'grid-cols-[var(--shell-cols)]' : 'grid-rows-[var(--shell-rows)]'}`} style={style}>
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
export function FloatingView(props: ViewProps & { readonly view: WorkspaceFloatingView; readonly overlay: boolean }) {
  const { view, controller, overlay } = props;
  const [interactive, setInteractive] = useState(false);
  const drag = useRef<{ x: number; y: number; view: WorkspaceFloatingView; resize: boolean } | null>(null);
  const style: Geometry = {
    '--shell-x': `${view.x}px`, '--shell-y': `${view.y}px`, '--shell-w': `${view.width}px`,
    '--shell-h': `${view.height}px`, '--shell-z': view.z + (overlay ? 100 : 10),
  };
  function start(event: PointerEvent<HTMLButtonElement>, resize: boolean) {
    drag.current = { x: event.clientX, y: event.clientY, view, resize };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent<HTMLButtonElement>) {
    const value = drag.current;
    if (!value) return;
    const canvas = event.currentTarget.closest('[data-workspace-canvas]');
    const width = canvas?.clientWidth ?? 1200, height = canvas?.clientHeight ?? 800;
    const dx = event.clientX - value.x, dy = event.clientY - value.y;
    controller.float(view.instanceId, value.resize
      ? { width: Math.min(width - value.view.x, value.view.width + dx), height: Math.min(height - value.view.y, value.view.height + dy) }
      : { x: Math.min(Math.max(0, width - 120), value.view.x + dx), y: Math.min(Math.max(0, height - 80), value.view.y + dy) });
  }
  function stop(event: PointerEvent<HTMLButtonElement>) {
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  return <section style={style} className={`absolute left-[var(--shell-x)] top-[var(--shell-y)] z-[var(--shell-z)] flex h-[var(--shell-h)] max-h-full w-[var(--shell-w)] max-w-full flex-col rounded-xl border border-[#CEC4FF] bg-white shadow-xl ${overlay ? 'pointer-events-none' : ''}`}
    onKeyDown={(event) => { if (event.key === 'Escape') { setInteractive(false); drag.current = null; } }}>
    <div className="pointer-events-auto flex shrink-0 items-center gap-2 rounded-t-xl bg-[#F2EFFF] px-3 py-2 text-xs">
      <button type="button" className="min-w-0 flex-1 cursor-move touch-none truncate text-left font-semibold text-[#6C4CF5]"
        onPointerDown={(event) => start(event, false)} onPointerMove={move} onPointerUp={stop} onPointerCancel={stop}
        onKeyDown={(event) => {
          const delta = event.shiftKey ? 1 : 10;
          if (event.key === 'ArrowLeft') controller.float(view.instanceId, { x: view.x - delta });
          else if (event.key === 'ArrowRight') controller.float(view.instanceId, { x: view.x + delta });
          else if (event.key === 'ArrowUp') controller.float(view.instanceId, { y: view.y - delta });
          else if (event.key === 'ArrowDown') controller.float(view.instanceId, { y: view.y + delta });
          else return;
          event.preventDefault();
        }} aria-label={`移动${overlay ? '覆盖层' : '浮窗'}，方向键调整位置`}>⠿ {overlay ? '覆盖层 · 默认只显示' : '浮动视图 · 拖动标题栏'}</button>
      {overlay && <button type="button" onClick={() => setInteractive((value) => !value)} className="rounded bg-white px-2 py-1 text-[#6C4CF5]">{interactive ? '结束交互' : '启用交互'}</button>}
      <button type="button" onClick={() => props.onClose(view.instanceId)} aria-label={`关闭${overlay ? '覆盖层' : '浮窗'}`} className="rounded px-1 text-base text-[#596479]">×</button>
    </div>
    <div className={`min-h-0 flex-1 overflow-auto ${overlay && !interactive ? 'pointer-events-none' : 'pointer-events-auto'}`} inert={overlay && !interactive}>
      <ViewFrame {...props} instanceId={view.instanceId} />
    </div>
    <button type="button" className="pointer-events-auto absolute bottom-1 right-1 h-5 w-5 cursor-se-resize touch-none rounded bg-[#F2EFFF] text-xs text-[#6C4CF5]"
      aria-label="缩放浮动视图，方向键调整尺寸" onPointerDown={(event) => start(event, true)} onPointerMove={move} onPointerUp={stop} onPointerCancel={stop}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') controller.float(view.instanceId, { width: view.width - 10 });
        else if (event.key === 'ArrowRight') controller.float(view.instanceId, { width: view.width + 10 });
        else if (event.key === 'ArrowUp') controller.float(view.instanceId, { height: view.height - 10 });
        else if (event.key === 'ArrowDown') controller.float(view.instanceId, { height: view.height + 10 });
        else return;
        event.preventDefault();
      }}>⌟</button>
  </section>;
}
