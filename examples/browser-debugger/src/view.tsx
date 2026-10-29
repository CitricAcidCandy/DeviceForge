import * as React from 'react';
import type { HostContext } from '../../../frontend/src/plugin-sdk/index.ts';
import type { DebuggerController } from './controller.ts';
import { ballPosition, fit, initialRect, resizeByKey, snapPanel } from './geometry.ts';
import type { Rect } from './geometry.ts';
import { DEBUGGER_STYLE } from './style.ts';
import { TreeView } from './tree-view.tsx';
import { TargetsView } from './targets-view.tsx';
import { InvokeView } from './invoke-view.tsx';
import { ReportView } from './report-view.tsx';
import { ActivityView } from './activity-view.tsx';
import { activitySteps, activitySummary } from './activity-presentation.ts';
import { DetailsView } from './details-view.tsx';
import { DataView } from './data-view.tsx';
import { json } from './protocol.ts';
import { Button, CopyId, ResultView } from './ui.tsx';

interface PositionStyle extends React.CSSProperties {
  '--df-x': string; '--df-y': string; '--df-width'?: string; '--df-height'?: string;
}
type Surface = 'process' | 'targets' | 'tree' | 'data' | 'invoke' | 'details' | 'report';
const surfaceTitles: Record<Surface, string> = { process: '调试过程', targets: '选择调试插件', tree: '检查界面', data: '查看数据',
  invoke: '调用公开能力', details: '技术详情', report: '保存调试报告' };
export function DebuggerApp({ controller, context }: { controller: DebuggerController; context: HostContext }) {
  const state = React.useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  const [surface, setSurface] = React.useState<Surface>('process');
  const [rect, setRect] = React.useState<Rect>({ x: 112, y: 48, width: 1200, height: 704 });
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
  React.useEffect(() => { if (state.requested) setSurface('targets'); }, [state.requested]);
  React.useEffect(() => { if (state.sessionId) setSurface('process'); }, [state.sessionId]);
  React.useEffect(() => {
    if (!state.open) return;
    let checking = false, closed = false;
    const timer = setInterval(() => {
      if (checking || controller.snapshot().busy) return;
      checking = true;
      void (async () => {
        try {
          await controller.checkConnection();
          if (!closed && state.sessionId && surface === 'process') await controller.refreshActivity();
        } finally { checking = false; }
      })();
    }, 5000);
    return () => { closed = true; clearInterval(timer); };
  }, [state.open, state.sessionId, surface, controller]);
  React.useEffect(() => {
    if (!state.busy?.startsWith('拾取')) return;
    const doc = ballRef.current?.ownerDocument;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); controller.cancel(); panel.current?.focus(); } };
    doc?.addEventListener('keydown', escape, true); return () => doc?.removeEventListener('keydown', escape, true);
  }, [state.busy, controller]);
  function collapse() { controller.collapse(); setKeyboardRect(null); requestAnimationFrame(() => ballRef.current?.focus()); }
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
  const canOperate = Boolean(state.sessionId) && !state.stale && state.connected && !state.busy;
  const selecting = surface === 'targets' || !state.target;
  const current = state.activityDetail ?? state.activity?.items[0] ?? null;
  const summary = selecting ? { title: '先选择要调试的插件', description: '选择插件 → 让 Agent 调用调试工具 → 在这里查看过程与结果。', warning: false }
    : surface === 'process' ? activitySummary(json(current), disconnected)
      : { title: surfaceTitles[surface], description: disconnected ? '最后观测内容已过期，仅供只读查看。' : '当前插件的公开能力；所有修改仍按实际回执确认。', warning: disconnected };
  async function pick() {
    setSurface('tree');
    await controller.action('pick', null, '', false, false);
  }
  function data() { setSurface('data'); void controller.refreshDataSources(); }
  return <div data-deviceforge-debugger="" data-deviceforge-debugger-internal="" className="font-sans text-[#23272E]">
    <style>{DEBUGGER_STYLE}</style>
    <button ref={ballRef} type="button" aria-label={state.open ? '收起调试器' : '打开调试器'} aria-expanded={state.open} aria-controls="deviceforge-debugger-panel"
      className={`${state.open ? 'hidden' : 'flex'} fixed left-[var(--df-x)] top-[var(--df-y)] z-[2147483001] size-12 touch-none select-none flex-col items-center justify-center rounded-full border border-white bg-[#6C4CF5] text-xs font-medium text-white shadow-lg outline-none focus-visible:ring-2 focus-visible:ring-[#6C4CF5] focus-visible:ring-offset-2`}
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
    <section ref={panel} id="deviceforge-debugger-panel" role="dialog" aria-modal="false" aria-labelledby="deviceforge-debugger-title" tabIndex={-1}
      hidden={!state.open || state.busy?.startsWith('拾取')} style={panelStyle} className={`${!state.open || state.busy?.startsWith('拾取') ? 'hidden' : 'flex'} fixed left-[var(--df-x)] top-[var(--df-y)] z-[2147483000] h-[var(--df-height)] w-[var(--df-width)] min-w-0 flex-col overflow-hidden rounded-2xl border border-[#E6EAF3] bg-white shadow-2xl outline-none`}
      onKeyDown={(event) => {
        if (keyboardRect) {
          if (event.key.startsWith('Arrow')) { event.preventDefault(); event.stopPropagation(); setRect((current) => resizeByKey(current, event.key, event.shiftKey, viewport())); }
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setRect(fit(keyboardRect, viewport())); setKeyboardRect(null); sizeRef.current?.focus(); }
          if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); setKeyboardRect(null); sizeRef.current?.focus(); }
          return;
        }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (state.busy?.startsWith('拾取')) controller.cancel(); else collapse(); }
      }}>
      <header className="flex min-h-[72px] shrink-0 touch-none flex-wrap items-center gap-3 px-6 py-3 select-none"
        title="拖动标题栏移动面板，靠近窗口边缘时吸附"
        onPointerDown={(event) => pointerStart('move', event)} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={pointerEnd}>
        <div className="mr-auto min-w-0"><h1 id="deviceforge-debugger-title" className="truncate text-[18px] font-semibold">{selecting ? '选择调试插件' : surfaceTitles[surface]}</h1>
          <p className="mt-1 truncate text-xs text-[#556176]">{state.target ? `${disconnected ? '最后调试' : '正在调试'}：${state.target.pluginId} · ${state.target.kind === 'server' ? '服务器插件' : '浏览器插件'}` : '在这里选择插件，无需寻找插件页面'}</p></div>
        <span className={`${disconnected ? 'bg-[#FDF6ED] text-[#8A4D00]' : state.connected ? 'bg-[#EAF8F0] text-[#17664F]' : 'bg-[#F7F8FC] text-[#556176]'} rounded-full px-4 py-1.5 text-xs`}>{disconnected ? '已断开' : state.connected ? '已连接' : '待连接'}</span>
        {state.target && <Button soft onClick={() => setSurface('targets')}>更换插件</Button>}
        <Button aria-label="收起调试器，保留会话" onClick={collapse}>收起</Button><button type="button" aria-label="关闭调试会话，保留悬浮入口" className="size-9 rounded-lg text-lg text-[#556176] outline-none focus-visible:ring-2 focus-visible:ring-[#6C4CF5]" onClick={() => { void controller.close().then(() => ballRef.current?.focus()); }}>×</button>
      </header>
      <div className={`${summary.warning ? 'bg-[#FDF6ED]' : 'bg-[#F7F8FC]'} min-h-24 shrink-0 space-y-2 px-6 py-4`}>
        <h2 className={`text-lg font-semibold ${summary.warning ? 'text-[#8A4D00]' : surface === 'process' && activitySteps(json(current)).some(step => step.status === '页面检查通过') ? 'text-[#17664F]' : 'text-[#23272E]'}`}>{summary.title}</h2>
        <p className="text-[13px] leading-relaxed text-[#556176]">{summary.description}</p>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-6">
        {state.error && <div role="alert" className="mb-3 space-y-2 rounded-md bg-[#FDF6ED] p-3 text-[13px] text-[#8A4D00]"><p>{state.error.message}</p><code className="block break-all text-xs">{state.error.code}</code><CopyId value={state.error.logId} /></div>}
        {disconnected && state.target && <div className="mb-4 flex flex-wrap items-center gap-3 text-[13px] text-[#8A4D00]"><span className="mr-auto">最后观测已过期；重新连接只恢复观察，不重放先前动作。</span><Button disabled={Boolean(state.busy)} onClick={() => void controller.reconnect(true)}>重新连接并核对目标</Button></div>}
        {selecting ? <TargetsView state={state} controller={controller} /> : <>
          {surface === 'process' && <ActivityView state={state} controller={controller} narrow={rect.width < 1040} onData={data} onInspect={() => void pick()} onDetails={() => setSurface('details')} onTargets={() => setSurface('targets')} />}
          {surface === 'tree' && <><p className="mb-4 text-sm text-[#556176]">在页面上选择后查看简短结果；完整树和查询工具可按需展开。</p><ResultView value={state.result} /><details className="mt-4 rounded-xl border border-[#E6EAF3] p-4"><summary className="cursor-pointer text-sm font-medium">节点树、属性与界面检查工具</summary><div className="mt-4"><TreeView state={state} controller={controller} /></div></details></>}
          {surface === 'data' && <DataView state={state} controller={controller} narrow={rect.width < 1040} />}
          {surface === 'invoke' && <><InvokeView state={state} controller={controller} /><div className="mt-4"><ResultView value={state.result} /></div></>}
          {surface === 'details' && <DetailsView state={state} controller={controller} context={context} onInvoke={() => setSurface('invoke')} onResize={() => { setKeyboardRect(rect); sizeRef.current?.focus(); }} />}
          {surface === 'report' && <ReportView state={state} controller={controller} context={context} />}
        </>}
      </div>
      <footer className="relative flex min-h-14 shrink-0 flex-wrap items-center gap-3 border-t border-[#E6EAF3] bg-[#FBFCFE] px-6 py-2 pr-10">
        {selecting ? <><p className="mr-auto text-[13px] text-[#556176]">{state.target ? '选择后切换观察目标，不会停止业务插件。' : '尚未选择插件，调试器不会读取页面。'}</p>{state.target && <Button onClick={() => setSurface('process')}>返回调试过程</Button>}</> : <>
          {surface !== 'process' ? <Button soft onClick={() => setSurface('process')}>← 返回调试过程</Button>
            : <Button soft disabled={!canOperate || state.target?.kind !== 'browser'} onClick={() => void pick()}>⌖ 在页面上选择</Button>}
          <details className="relative"><summary className="cursor-pointer rounded-lg bg-white px-3 py-2 text-[13px] focus-visible:ring-2 focus-visible:ring-[#6C4CF5]">手动检查 ▾</summary><div className="absolute bottom-full left-0 z-10 mb-2 flex min-w-40 flex-col gap-1 rounded-xl border border-[#E6EAF3] bg-white p-2 shadow-lg">
            <Button disabled={!state.target} onClick={() => setSurface('tree')}>检查界面</Button><Button disabled={!state.target} onClick={data}>查看数据</Button><Button disabled={!state.target} onClick={() => setSurface('invoke')}>调用公开能力</Button>
          </div></details><span className="mr-auto" />
          <Button onClick={() => setSurface('details')}>技术详情 ›</Button>{current && <Button onClick={() => setSurface('report')}>保存报告</Button>}
        </>}
        {state.busy && <Button onClick={() => controller.cancel()}>停止等待</Button>}
        <span role="status" className="sr-only">{keyboardRect ? '方向键每次8像素，Shift32像素；Enter应用，Esc取消' : state.notice}</span>
        {keyboardRect && <button ref={sizeRef} type="button" className="text-[13px] text-[#6C4CF5]" onClick={() => setKeyboardRect(null)}>完成尺寸调整</button>}
        <button type="button" aria-label="拖动调整调试面板尺寸" className="absolute right-0 bottom-0 flex size-7 touch-none cursor-se-resize items-center justify-center rounded-br-xl text-lg text-[#556176] outline-none focus-visible:ring-2 focus-visible:ring-[#6C4CF5]"
          onPointerDown={(event) => pointerStart('resize', event)} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={pointerEnd}
          onKeyDown={(event) => { if (event.key.startsWith('Arrow')) { event.preventDefault(); setRect((current) => resizeByKey(current, event.key, event.shiftKey, viewport())); } }}>╱╱</button>
      </footer>
    </section>
    {state.open && state.busy?.startsWith('拾取') && <div role="status" className="fixed bottom-6 left-1/2 z-[2147483001] -translate-x-1/2 rounded-full border border-[#E6EAF3] bg-white px-5 py-3 text-sm shadow-lg">在页面上选择元素 · Esc 取消 <Button onClick={() => controller.cancel()}>取消选择</Button></div>}
  </div>;
}
