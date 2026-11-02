import { useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react';
import { ChevronUp } from 'lucide-react';
import { hostUi } from '@deviceforge/plugin-sdk';
import type { HostContext } from '@deviceforge/plugin-sdk';
import { createTaskFooterModel, taskFooterCounts } from './footer-model.ts';
import type { TaskFooterState } from './footer-model.ts';
import { resolveTaskPage, taskPageJobs } from './drawer-rules.ts';
import { TaskDrawer } from './task-drawer.tsx';

const initial: TaskFooterState = { pending: false, jobs: [], updatedAt: null, error: null, logId: null };
const emptyPages = Object.freeze([]);
export function TaskFooter({ context, browser = typeof window === 'undefined' ? null : window }: {
  context: HostContext; browser?: Window | null;
}) {
  const [model, setModel] = useState<ReturnType<typeof createTaskFooterModel> | null>(null);
  useEffect(() => {
    const next = createTaskFooterModel(context);
    setModel(next); next.start();
    return () => next.dispose();
  }, [context]);
  return model ? <TaskFooterContent model={model} context={context} browser={browser} /> : <span className="text-xs text-muted-foreground">任务状态尚未读取</span>;
}
function TaskFooterContent({ model, context, browser }: {
  model: ReturnType<typeof createTaskFooterModel>; context: HostContext; browser: Window | null;
}) {
  const state = useSyncExternalStore(model.subscribe, model.snapshot, () => initial);
  const [open, setOpen] = useState(false);
  const drawerId = `task-drawer-${useId()}`;
  const stores = useMemo(() => ({
    route: {
      subscribe(listener: () => void) { browser?.addEventListener('hashchange', listener); return () => browser?.removeEventListener('hashchange', listener); },
      snapshot: () => browser?.location.hash ?? '',
    },
    pages: {
      subscribe: (listener: () => void) => context.ui?.subscribe(listener) ?? (() => {}),
      snapshot: () => context.signal.aborted ? emptyPages : context.ui?.catalog().pages ?? emptyPages,
    },
  }), [context, browser]);
  const hash = useSyncExternalStore(stores.route.subscribe, stores.route.snapshot, stores.route.snapshot);
  const pages = useSyncExternalStore(stores.pages.subscribe, stores.pages.snapshot, stores.pages.snapshot);
  const scope = resolveTaskPage(pages, hash), jobs = taskPageJobs(state.jobs, scope.page);
  const counts = taskFooterCounts(jobs), active = counts.running + counts.queued;
  const reason = scope.reason === 'conflict' ? '当前页面地址冲突，任务范围未确认' : !scope.page ? '当前页面提供者不可用，任务范围未确认' : null;
  return <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground" aria-label="当前页面任务状态">
    <button type="button" aria-label="当前页面任务" aria-expanded={open} aria-controls={drawerId}
      onClick={() => setOpen((value) => !value)}
      className="flex min-h-[26px] min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <span className="tracking-widest text-muted-foreground">任务</span>
      {reason ? <span>范围未确认</span> : state.updatedAt === null ? <span>{state.pending ? '读取中…' : '尚无观测'}</span> : <>
        <span className={active ? 'font-medium text-primary' : 'font-medium'}>{active ? `${active} 进行中` : '空闲'}</span>
        {counts.failed > 0 && <span className="text-destructive">{counts.failed} 失败</span>}
        <span className="text-muted-foreground">{jobs.length} 条记录</span>
      </>}
      <ChevronUp aria-hidden="true" className={`size-3 shrink-0 ${open ? 'rotate-180' : ''}`} />
    </button>
    <span className="sr-only">仅统计最近最多二百条任务中属于当前页面的记录，不代表全部历史。</span>
    {state.error && <span role="status" className="max-w-64 truncate text-destructive" title={`${state.error}${state.logId ? ` · 日志 ${state.logId}` : ''}`}>
      {state.updatedAt === null ? '状态未确认' : '显示旧观测'}：{state.error}
    </span>}
    <TaskDrawer key={`${scope.page?.pluginId}:${scope.page?.id}:${scope.page?.generation}`} context={context}
      page={scope.page} jobs={jobs} state={state} reason={reason} open={open} onOpenChange={setOpen}
      id={drawerId} onRefresh={() => { void model.refresh(); }} />
  </div>;
}
export function mountTaskFooter(target: HTMLElement, context: HostContext) {
  return hostUi().mountReact(target, <TaskFooter context={context} browser={target.ownerDocument.defaultView} />);
}
