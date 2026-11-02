import { useEffect, useState, useSyncExternalStore } from 'react';
import { ArrowUpRight, Copy, RefreshCw } from 'lucide-react';
import { hostUi } from '@deviceforge/plugin-sdk';
import type { HistoricalJob, HostContext, WorkspacePageInfo } from '@deviceforge/plugin-sdk';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@deviceforge/business-kit/sheet';
import type { TaskFooterState } from './footer-model.ts';
import { filterTaskJobs } from './drawer-rules.ts';
import type { TaskDockFilter } from './drawer-rules.ts';
import { createTaskDetailsModel } from './drawer-details.ts';
import type { TaskDetailsState } from './drawer-details.ts';
import { copyText } from './view-support.tsx';
import { useTaskOperationTitles } from './operation-titles.ts';

const labels = { queued: '排队中', running: '运行中', succeeded: '成功', failed: '失败', cancelled: '已取消' };
const filters: readonly { id: TaskDockFilter; title: string }[] = [
  { id: 'active', title: '进行中' }, { id: 'failed', title: '失败' }, { id: 'all', title: '全部' },
];

export function TaskDrawer({ context, page, jobs, state, reason, open, onOpenChange, id, onRefresh }: {
  context: HostContext; page: WorkspacePageInfo | null; jobs: readonly HistoricalJob[];
  state: TaskFooterState; reason: string | null; open: boolean; onOpenChange(value: boolean): void;
  id: string; onRefresh(): void;
}) {
  const [filter, setFilter] = useState<TaskDockFilter | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detailRefresh, setDetailRefresh] = useState(0);
  const titles = useTaskOperationTitles(context, open);
  const active = jobs.filter((job) => job.status === 'running' || job.status === 'queued').length;
  const current = filter ?? (active ? 'active' : 'all');
  const visible = filterTaskJobs(jobs, current);
  const { Button, ErrorNotice } = hostUi();
  const empty = reason ?? (state.error && state.updatedAt === null ? '任务记录读取失败' : state.updatedAt === null
    ? '正在读取任务…' : current === 'active' ? '当前页面没有进行中的任务'
      : current === 'failed' ? '没有失败记录' : '当前页面还没有任务记录');
  return <Sheet open={open} onOpenChange={onOpenChange}>
    <SheetContent side="bottom" id={id}
      className="@container/task-drawer h-[min(48dvh,420px)] max-h-[90dvh] min-h-0 min-w-0 gap-0 rounded-t-[14px] border-t border-border bg-background p-0">
      <SheetHeader className="min-w-0 flex-row flex-wrap items-center gap-x-3 gap-y-2 px-4 pb-2 pt-3 pr-12">
        <SheetTitle className="min-w-0 break-words text-xs font-medium">
          {page?.taskPolicy === 'all' ? '全部任务' : `${page?.title ?? '当前页面'} · 任务`}
        </SheetTitle>
        <SheetDescription className="sr-only">按创建时间倒序，展示最近最多二百条中的当前页面任务；明细仅读取，不派发或取消业务。</SheetDescription>
        <span className="text-xs text-muted-foreground">{active ? `${active} 进行中` : state.updatedAt !== null && !reason ? '空闲' : '尚未确认'}</span>
        <div role="group" aria-label="任务筛选" className="flex min-w-0 flex-wrap items-center gap-1 @min-[600px]/task-drawer:ml-auto">
          {filters.map((entry) => <button key={entry.id} type="button" data-task-filter={entry.id}
            aria-pressed={current === entry.id} onClick={() => setFilter(entry.id)}
            className={`rounded px-2 py-1 text-xs focus-visible:ring-2 focus-visible:ring-ring ${current === entry.id
              ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'}`}>{entry.title}</button>)}
          <Button type="button" variant="ghost" size="icon-xs" className="size-6" disabled={state.pending}
            aria-label="刷新任务记录" title="重新读取最近最多200条记录" onClick={() => {
              onRefresh(); setDetailRefresh((value) => value + 1);
            }}>
            <RefreshCw className="size-3" aria-hidden="true" />
          </Button>
        </div>
      </SheetHeader>
      <div tabIndex={0} aria-label="任务列表" className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 pb-2">
        {state.error && <ErrorNotice message={`${state.updatedAt === null ? '' : '显示旧观测：'}${state.error}`} logId={state.logId} />}
        {visible.length === 0 ? <p role="status" className="py-6 text-center text-xs text-muted-foreground">{empty}</p>
          : visible.map((job) => <article key={job.id} data-task-id={job.id} className="min-w-0 space-y-1.5 border-t border-border py-2.5 first:border-t-0 first:pt-1">
            <button type="button" className="flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-left text-xs focus-visible:ring-2 focus-visible:ring-ring"
              aria-expanded={selected === job.id} onClick={() => setSelected((value) => value === job.id ? null : job.id)}>
              <span title={job.operation} className="min-w-0 break-all font-medium">{titles.get(job.operation) ?? job.operation}</span>
              <span className={job.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}>{labels[job.status]}</span>
            </button>
            {(job.status === 'running' || job.status === 'queued') && <div role="status" className="text-[10px] text-muted-foreground">等待任务结果，不提供估算进度</div>}
            <p className="break-all font-mono text-[10px] text-muted-foreground">{job.id} · {new Date(job.createdAt).toLocaleTimeString('zh-CN')}</p>
            {open && selected === job.id && <TaskDetail context={context} job={job} refreshRevision={detailRefresh} />}
          </article>)}
      </div>
      <div className="flex min-w-0 shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-1.5 text-xs text-muted-foreground">
        <span>{jobs.length} 条记录 · 最近最多200条{state.updatedAt === null ? '尚未读取' : '中的匹配项'}</span>
        {page?.taskPolicy !== 'all' && <a href="#/tasks" className="inline-flex items-center gap-1 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          任务与日志<ArrowUpRight className="size-3" aria-hidden="true" />
        </a>}
      </div>
    </SheetContent>
  </Sheet>;
}

const initialDetails: TaskDetailsState = { pending: false, id: null, job: null, events: [], error: null, logId: null };
function TaskDetail({ context, job, refreshRevision }: { context: HostContext; job: HistoricalJob; refreshRevision: number }) {
  const [model, setModel] = useState<ReturnType<typeof createTaskDetailsModel> | null>(null);
  useEffect(() => {
    const next = createTaskDetailsModel(context);
    setModel(next);
    return () => next.dispose();
  }, [context]);
  useEffect(() => {
    if (!model) return;
    void model.read(job.id);
    return () => model.clear();
  }, [model, job.id, refreshRevision]);
  return model ? <TaskDetailContent model={model} listed={job} /> : <p className="text-xs text-muted-foreground">正在读取明细…</p>;
}

function TaskDetailContent({ model, listed }: { model: ReturnType<typeof createTaskDetailsModel>; listed: HistoricalJob }) {
  const state = useSyncExternalStore(model.subscribe, model.snapshot, () => initialDetails);
  const [copied, setCopied] = useState<string | null>(null);
  const { Button, ErrorNotice, JsonResult } = hostUi();
  const current = state.job ?? listed;
  return <div aria-label="任务明细" className="min-w-0 space-y-2 py-1 text-xs text-muted-foreground">
    {state.pending && <p role="status">正在读取明细…</p>}
    {state.error && <ErrorNotice message={state.error} logId={state.logId} />}
    {!state.job && <p>以下为列表观测，明细尚未确认。</p>}
    {state.job && <p className="text-[10px]">明细为最近一次读取结果，可通过刷新重新核对。</p>}
    {current.error && <p role="status" className="break-words border-l-2 border-destructive bg-destructive/5 px-2 py-1 text-destructive">{current.error}</p>}
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Button type="button" variant="ghost" size="xs" className="h-[22px] px-1.5 text-xs" onClick={() => {
        void copyText(listed.id).then((ok) => setCopied(ok ? '任务 ID 已复制' : '复制失败，请手动选择任务 ID'));
      }}><Copy className="size-3" aria-hidden="true" />复制 ID</Button>
      {state.logId && <span className="break-all font-mono text-[10px]">日志 {state.logId}</span>}
      {copied && <span role="status">{copied}</span>}
    </div>
    <details><summary className="cursor-pointer">事件 · {state.events.length}</summary>
      <ol className="mt-1 space-y-1 font-mono text-[10px]">{state.events.map((event) => <li key={event.sequence} className="flex flex-wrap gap-2">
        <time>{new Date(event.timestamp).toLocaleTimeString('zh-CN')}</time><span>{labels[event.status]}</span>
      </li>)}</ol>
    </details>
    <details><summary className="cursor-pointer">提交内容</summary>
      <pre className="mt-1 max-h-[180px] min-w-0 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-[11px]">{JSON.stringify(current.input, null, 2)}</pre>
    </details>
    <JsonResult value={current.result} />
  </div>;
}
