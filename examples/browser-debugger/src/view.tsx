import * as React from 'react';
import type { HostContext } from '../../../frontend/src/plugin-sdk/index.ts';
import type { DebuggerController } from './controller.ts';
import { ballPosition, fit, initialRect, resizeByKey, snapPanel } from './geometry.ts';
import type { Rect } from './geometry.ts';
import { DEBUGGER_STYLE } from './style.ts';
import { TreeView } from './tree-view.tsx';
import { CatalogView, TargetsView } from './targets-view.tsx';
import { InvokeView } from './invoke-view.tsx';
import { TimelineView } from './timeline-view.tsx';
import { ReportView } from './report-view.tsx';
import { Badge, Button, Check, CopyId, Empty, ResultView } from './ui.tsx';

interface PositionStyle extends React.CSSProperties {
  '--df-x': string; '--df-y': string; '--df-width'?: string; '--df-height'?: string;
}
type Tab = 'targets' | 'tree' | 'catalog' | 'invoke' | 'timeline' | 'report';
const tabs: readonly { readonly id: Tab; readonly label: string }[] = [
  { id: 'targets', label: '调试目标' }, { id: 'tree', label: 'UI 树' }, { id: 'catalog', label: '公开目录' },
  { id: 'invoke', label: '试调用' }, { id: 'timeline', label: '事件与日志' }, { id: 'report', label: '报告与重载' },
];
export function DebuggerApp({ controller, context }: { controller: DebuggerController; context: HostContext }) {
  const state = React.useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  const [tab, setTab] = React.useState<Tab>('targets'), [showOld, setShowOld] = React.useState(false);
  const [reconnectConfirmed, setReconnectConfirmed] = React.useState(false);
  const [rect, setRect] = React.useState<Rect>({ x: 16, y: 64, width: 1032, height: 640 });
  const [ball, setBall] = React.useState({ x: 16, y: 16 });
  const [keyboardRect, setKeyboardRect] = React.useState<Rect | null>(null);
  const panel = React.useRef<HTMLElement>(null), ballRef = React.useRef<HTMLButtonElement>(null), sizeRef = React.useRef<HTMLButtonElement>(null);
  const suppressClick = React.useRef(false);
  const drag = React.useRef<{ readonly mode: 'move' | 'resize' | 'ball'; readonly pointerId: number;
    readonly x: number; readonly y: number; readonly rect: Rect; readonly ball: { x: number; y: number }; moved: boolean } | null>(null);
  const viewport = () => { const view = ballRef.current?.ownerDocument.defaultView; return { width: view?.innerWidth ?? 1424, height: view?.innerHeight ?? 805 }; };
  React.useEffect(() => {
    const view = ballRef.current?.ownerDocument.defaultView;
    if (!view) return;
    setRect(initialRect(viewport())); setBall(ballPosition(view.innerWidth - 72, view.innerHeight - 64, viewport(), true));
    const resize = () => { setRect((current) => fit(current, viewport())); setBall((current) => ballPosition(current.x, current.y, viewport(), true)); };
    view.addEventListener('resize', resize); return () => view.removeEventListener('resize', resize);
  }, []);
  React.useEffect(() => {
    if (!state.open) return;
    const frame = requestAnimationFrame(() => panel.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [state.open]);
  React.useEffect(() => { if (state.requested) setTab('targets'); }, [state.requested]);
  React.useEffect(() => { if (state.sessionId) { setTab(state.target?.kind === 'server' ? 'invoke' : 'tree'); setShowOld(false); } }, [state.sessionId]);
  React.useEffect(() => { if (state.stale) setShowOld(false); }, [state.stale]);
  React.useEffect(() => {
    if (!state.open) return;
    const timer = setInterval(() => { void controller.checkConnection(); }, 5000);
    return () => clearInterval(timer);
  }, [state.open, controller]);
  React.useEffect(() => {
    if (!state.busy?.startsWith('拾取')) return;
    const doc = ballRef.current?.ownerDocument;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); controller.cancel(); panel.current?.focus(); } };
    doc?.addEventListener('keydown', escape, true); return () => doc?.removeEventListener('keydown', escape, true);
  }, [state.busy, controller]);
  function collapse() { controller.collapse(); setKeyboardRect(null); ballRef.current?.focus(); }
  function pointerStart(mode: 'move' | 'resize' | 'ball', event: React.PointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    if (mode === 'move' && event.target instanceof Element && event.target.closest('button,input,select,textarea,a')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { mode, pointerId: event.pointerId, x: event.clientX, y: event.clientY, rect, ball, moved: false };
  }
  function pointerMove(event: React.PointerEvent<HTMLElement>) {
    const current = drag.current; if (!current || current.pointerId !== event.pointerId) return;
    const dx = event.clientX - current.x, dy = event.clientY - current.y;
    if (Math.abs(dx) + Math.abs(dy) > 5) current.moved = true;
    if (!current.moved) return;
    if (current.mode === 'ball') setBall(ballPosition(current.ball.x + dx, current.ball.y + dy, viewport(), false));
    else if (current.mode === 'move') setRect(fit({ ...current.rect, x: current.rect.x + dx, y: current.rect.y + dy }, viewport()));
    else setRect(fit({ ...current.rect, width: current.rect.width + dx, height: current.rect.height + dy }, viewport()));
  }
  function pointerEnd(event: React.PointerEvent<HTMLElement>) {
    const current = drag.current; if (!current || current.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    drag.current = null;
    if (current.mode === 'ball' && current.moved) {
      setBall((position) => ballPosition(position.x, position.y, viewport(), true)); suppressClick.current = true;
    } else if (current.mode === 'move' && current.moved) {
      setRect((position) => snapPanel(position, viewport()));
    }
  }
  const panelStyle: PositionStyle = { '--df-x': `${rect.x}px`, '--df-y': `${rect.y}px`, '--df-width': `${rect.width}px`, '--df-height': `${rect.height}px` };
  const ballStyle: PositionStyle = { '--df-x': `${ball.x}px`, '--df-y': `${ball.y}px` };
  const disconnected = state.stale || (Boolean(state.instanceId) && !state.connected);
  const oldSummary = disconnected && !showOld && (tab === 'tree' || tab === 'invoke' || tab === 'catalog');
  const canOperate = Boolean(state.sessionId) && !state.stale && state.connected && !state.busy;
  return <div data-deviceforge-debugger="" data-deviceforge-debugger-internal="" className="font-sans text-[#23272E]">
    <style>{DEBUGGER_STYLE}</style>
    <button ref={ballRef} type="button" aria-label={state.open ? '收起调试器' : '打开调试器'} aria-expanded={state.open} aria-controls="deviceforge-debugger-panel"
      className="fixed left-[var(--df-x)] top-[var(--df-y)] z-[2147483001] flex size-12 touch-none select-none flex-col items-center justify-center rounded-full border border-white bg-[#6C4CF5] text-xs font-medium text-white shadow-lg outline-none focus-visible:ring-2 focus-visible:ring-[#6C4CF5] focus-visible:ring-offset-2"
      style={ballStyle} onPointerDown={(event) => pointerStart('ball', event)} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={pointerEnd}
      onKeyDown={(event) => {
        if (!event.altKey || !event.key.startsWith('Arrow')) return;
        event.preventDefault(); const step = event.shiftKey ? 32 : 8;
        setBall((position) => ballPosition(position.x + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0),
          position.y + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0), viewport(), false));
      }} onClick={() => {
        if (suppressClick.current) { suppressClick.current = false; return; }
        if (state.open) collapse(); else void controller.open();
      }} title="调试器；拖动吸边，Alt + 方向键移动"><span aria-hidden="true">⌘</span><span>调试</span></button>
    {state.open && <section ref={panel} id="deviceforge-debugger-panel" role="dialog" aria-modal="false" aria-labelledby="deviceforge-debugger-title" tabIndex={-1}
      style={panelStyle} className="fixed left-[var(--df-x)] top-[var(--df-y)] z-[2147483000] flex h-[var(--df-height)] w-[var(--df-width)] min-w-0 flex-col overflow-hidden rounded-xl border border-[#E6EAF3] bg-white shadow-2xl outline-none"
      onKeyDown={(event) => {
        if (keyboardRect) {
          if (event.key.startsWith('Arrow')) { event.preventDefault(); event.stopPropagation(); setRect((current) => resizeByKey(current, event.key, event.shiftKey, viewport())); }
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setRect(fit(keyboardRect, viewport())); setKeyboardRect(null); sizeRef.current?.focus(); }
          if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); setKeyboardRect(null); sizeRef.current?.focus(); }
          return;
        }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (state.busy?.startsWith('拾取')) controller.cancel(); else collapse(); }
      }}>
      <header className="flex h-12 shrink-0 touch-none items-center gap-3 border-b border-[#E6EAF3] px-4 select-none"
        onPointerDown={(event) => pointerStart('move', event)} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={pointerEnd}>
        <h1 id="deviceforge-debugger-title" className="mr-auto truncate text-[17px] font-semibold">DeviceForge Debugger</h1>
        <Badge warning={disconnected}>{disconnected ? '已断线 / 过期' : state.connected ? '已连接' : '待连接'}</Badge>
        <Button aria-label="收起调试器，保留会话" onClick={collapse}>收起</Button><Button aria-label="关闭调试会话" onClick={() => { void controller.close().then(() => ballRef.current?.focus()); }}>关闭</Button>
      </header>
      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-[#E6EAF3] px-4 py-2 text-xs text-[#556176]">
        <span className="min-w-0 break-all" title={state.target?.instanceId ?? state.instanceId ?? ''}>实例 <code>{state.target?.instanceId ?? state.instanceId ?? '未连接'}</code></span>
        <span className="min-w-0 break-all">插件 <code>{state.target?.pluginId ?? '未选择'}</code></span><span className="break-all">代次 <code>{state.target?.generation ?? '未提供'}{state.stale ? '（旧）' : ''}</code></span>
      </div>
      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b border-[#E6EAF3] px-4 py-1.5 text-[13px]">
        <span className="mr-auto text-[#556176]">{state.sessionId ? `会话 ${state.sessionState}` : '选择插件后才开始采集'}</span>
        <Button onClick={() => setTab('targets')}>选择其他目标</Button><Button disabled={!canOperate} onClick={() => void controller.refreshInspection()}>检查目标</Button>
      </div>
      <nav aria-label="调试页签" className="flex min-h-10 shrink-0 gap-1 overflow-x-auto border-b border-[#E6EAF3] px-3">
        {tabs.map((item) => <button key={item.id} type="button" aria-current={tab === item.id ? 'page' : undefined}
          className={`${tab === item.id ? 'border-[#6C4CF5] text-[#6C4CF5]' : 'border-transparent text-[#556176]'} shrink-0 border-b-2 px-3 py-2 text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-[#6C4CF5]`}
          onClick={() => setTab(item.id)}>{item.label}</button>)}
      </nav>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto p-4">
        {state.error && <div role="alert" className="mb-3 space-y-2 rounded-md bg-[#FDF6ED] p-3 text-[13px] text-[#8A4D00]"><p>{state.error.message}</p><code className="block break-all text-xs">{state.error.code}</code><CopyId value={state.error.logId} /></div>}
        {oldSummary ? <div className="space-y-4"><Empty title="连接已断开，当前状态未知">
          最后快照与历史日志仍可查看。重新连接只恢复观察；原调用不自动重放。{state.tree && <p className="mt-2">最后观测：{new Date(state.tree.observedAt).toLocaleString()} · 旧代次 {state.target?.generation}</p>}
        </Empty><div className="flex flex-wrap gap-2"><Button disabled={!state.tree} onClick={() => { setShowOld(true); setTab('tree'); }}>查看最后快照（只读 / 已过期）</Button><Button onClick={() => setTab('timeline')}>查看历史日志</Button><Button onClick={() => setTab('targets')}>选择其他目标</Button></div>
          <Check checked={reconnectConfirmed} onChange={setReconnectConfirmed}>确认建立新浏览器实例，不重放原调用</Check><Button disabled={!reconnectConfirmed || Boolean(state.busy)} primary onClick={() => { void controller.reconnect(reconnectConfirmed); setReconnectConfirmed(false); }}>重新连接</Button>
        </div> : <>
          {disconnected && showOld && tab === 'tree' && <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md bg-[#FDF6ED] p-3 text-[13px] text-[#8A4D00]"><span className="mr-auto">已过期：仅最后观测，不代表当前运行状态；所有节点动作已停用。</span><Button onClick={() => setShowOld(false)}>返回断线摘要</Button></div>}
          {tab === 'targets' && <TargetsView state={state} controller={controller} />}
          {tab === 'tree' && <TreeView state={state} controller={controller} />}
          {tab === 'catalog' && <CatalogView state={state} controller={controller} />}
          {tab === 'invoke' && <InvokeView state={state} controller={controller} />}
          {tab === 'timeline' && <TimelineView state={state} controller={controller} />}
          {tab === 'report' && <ReportView state={state} controller={controller} context={context} />}
          {(tab === 'tree' || tab === 'invoke') && <div className="mt-3"><ResultView value={state.result} /></div>}
        </>}
      </div>
      <footer className="relative flex min-h-11 shrink-0 items-center gap-2 border-t border-[#E6EAF3] bg-[#FBFCFE] px-4 pr-10 py-1.5">
        <p role="status" title={state.notice} className="mr-auto min-w-0 truncate text-[13px] text-[#556176]">{keyboardRect ? '方向键每次 8px，Shift 32px；Enter 应用，Esc 取消' : state.busy ? `正在${state.busy}` : state.notice}</p>
        {state.busy && <Button onClick={() => controller.cancel()}>取消等待</Button>}
        <button ref={sizeRef} type="button" aria-pressed={Boolean(keyboardRect)} className="shrink-0 rounded-md border border-[#E6EAF3] bg-white px-2 py-1.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-[#6C4CF5]" onClick={() => { if (!keyboardRect) setKeyboardRect(rect); else setKeyboardRect(null); sizeRef.current?.focus(); }}>键盘调尺寸</button>
        <Button disabled={!canOperate} onClick={() => void controller.refreshInspection()}>{disconnected ? '刷新不可用' : '刷新检查'}</Button>
        <button type="button" aria-label="拖动调整调试面板尺寸" className="absolute right-0 bottom-0 flex size-7 touch-none cursor-se-resize items-center justify-center rounded-br-xl text-lg text-[#556176] outline-none focus-visible:ring-2 focus-visible:ring-[#6C4CF5]"
          onPointerDown={(event) => pointerStart('resize', event)} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={pointerEnd}
          onKeyDown={(event) => { if (event.key.startsWith('Arrow')) { event.preventDefault(); setRect((current) => resizeByKey(current, event.key, event.shiftKey, viewport())); } }}>╱╱</button>
      </footer>
    </section>}
  </div>;
}
