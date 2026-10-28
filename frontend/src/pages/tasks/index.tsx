import { useEffect, useRef, useState } from 'react';
import { Copy, RefreshCw, Square } from 'lucide-react';
import { Button } from '../../components/Button/index.tsx';
import { Input } from '../../components/Input/index.tsx';
import type { JobDto, JobEventDto, LogOrder } from '../../services/api/index.ts';
import type { ProductServices } from '../../app/product/services.ts';
import { formatJobProgress } from '../../features/tasks/index.ts';
import type { TaskLookup } from '../../features/tasks/index.ts';
import { useAction, useSnapshot } from '../../app/product/hooks.ts';
import { EmptyState, JsonResult } from '../../components/index.ts';
import { TaskArtifacts } from './components/TaskArtifacts/index.tsx';
import { cn } from '../../utils/classnames.ts';
import { LogRecords } from './LogRecords.tsx';
import { copyText } from '../../shared/clipboard/index.ts';

const taskStates = {
  queued: '排队中',
  running: '运行中',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
};

type JobState = keyof typeof taskStates;

// 状态只用「色点 + 文字」表达；tag 底只出现在明细头的当前状态上。
const stateDot: Record<JobState, string> = {
  queued: 'bg-[color:var(--warning)]',
  running: 'bg-[color:var(--info)]',
  succeeded: 'bg-[color:var(--success)]',
  failed: 'bg-[color:var(--destructive)]',
  cancelled: 'bg-[color:var(--text-ghost)]',
};

const stateText: Record<JobState, string> = {
  queued: 'text-[color:var(--warning)]',
  running: 'text-[color:var(--info)]',
  succeeded: 'text-[color:var(--success)]',
  failed: 'text-[color:var(--destructive)]',
  cancelled: 'text-[color:var(--text-muted)]',
};

const stateChip: Record<JobState, string> = {
  queued: 'bg-[color:var(--warning)]/10 text-[color:var(--warning)]',
  running: 'bg-[color:var(--info)]/10 text-[color:var(--info)]',
  succeeded: 'bg-[color:var(--success)]/10 text-[color:var(--success)]',
  failed: 'bg-[color:var(--destructive)]/10 text-[color:var(--destructive)]',
  cancelled: 'bg-[color:var(--surface-sunken)] text-[color:var(--text-muted)]',
};

const filters: readonly { readonly id: string; readonly label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'active', label: '运行与排队' },
  { id: 'succeeded', label: '成功' },
  { id: 'failed', label: '失败' },
  { id: 'cancelled', label: '取消' },
];

const running = (job: JobDto) => job.status === 'queued' || job.status === 'running';

function StateChip({ status }: { status: JobState }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded-[6px] px-2 py-0.5 text-[12px] font-medium',
        stateChip[status],
      )}
    >
      {taskStates[status]}
    </span>
  );
}

/** 浅色代码块：日志与提交内容都装在它里面，不再用深色块做区分。 */
function PaperBlock({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[13px] font-semibold text-[color:var(--text-muted)]">{title}</h3>
        {aside}
      </div>
      <div className="mt-2 rounded-[8px] bg-[color:var(--surface-hover)] px-3.5 py-2.5">
        {children}
      </div>
    </section>
  );
}

export function TasksPage({ services }: { services: ProductServices }) {
  const [jobs, setJobs] = useState<readonly JobDto[]>([]);
  const [events, setEvents] = useState<readonly JobEventDto[]>([]);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [order, setOrder] = useState<LogOrder>('desc');
  const [loaded, setLoaded] = useState(false);
  const [lookupResult, setLookupResult] = useState<TaskLookup | null>(null);
  const lookupAction = useAction();
  const lookupActive = useRef(false);
  lookupActive.current = query.trim().length > 0 || lookupResult !== null || lookupAction.pending;
  const limit = useRef(50);
  const root = useRef<HTMLDivElement>(null);
  const action = useAction();
  const details = useAction();
  const selection = useSnapshot(services.runtime.tasks);
  const selected = selection.result?.data;
  const selectedId = useRef<string | null>(null);
  selectedId.current = selected?.id ?? null;
  const detailsPending = useRef(false);
  detailsPending.current = details.pending;
  const refreshState = useRef<{ pending: boolean; error: unknown }>({ pending: false, error: null });
  refreshState.current = { pending: action.pending, error: action.error };
  async function refresh(signal: AbortSignal, requestedLimit = limit.current) {
    const response = await services.runtime.tasks.list({ limit: requestedLimit }, signal);
    if (!signal.aborted) {
      limit.current = requestedLimit;
      setJobs(response.data);
      setLoaded(true);
    }
    return response;
  }
  useEffect(() => {
    void action.run(refresh, { quiet: true });
    const timer = window.setInterval(() => {
      if (
        document.visibilityState === 'visible' &&
        !root.current?.closest('[hidden]') &&
        !lookupActive.current &&
        !refreshState.current.pending &&
        !refreshState.current.error
      ) {
        void action.run(refresh, { quiet: true });
        if (selectedId.current && !detailsPending.current) select(selectedId.current, true);
      }
    }, 10000);
    return () => window.clearInterval(timer);
  }, [services]);
  const listedJobs = lookupResult?.jobs ?? jobs;
  const visibleJobs = listedJobs
    .filter(
      (job) =>
        (filter === 'all' || filter === 'active'
          ? filter === 'all' || running(job)
          : job.status === filter),
    )
    .sort(
      (left, right) =>
        (left.created_at - right.created_at) * (order === 'desc' ? -1 : 1),
    );
  const visibleEvents = [...events].sort((left, right) =>
    (left.timestamp - right.timestamp || left.sequence - right.sequence) * (order === 'desc' ? -1 : 1));
  function select(id: string, quiet = false) {
    void details.run(async (signal) => {
      const [job, updates] = await Promise.all([
        services.runtime.tasks.select(id, signal),
        services.runtime.tasks.events(id, {}, signal),
      ]);
      if (!signal.aborted) setEvents(updates.data);
      return job;
    }, { quiet, success: null, pending: '正在读取任务…' });
  }
  async function copyTaskId(id: string) {
    if (await copyText(id)) {
      services.messages.success('任务 ID 已复制');
    } else {
      services.messages.warning('复制失败，请手动选择任务 ID');
    }
  }
  function lookup(nextOrder = order) {
    const id = query.trim();
    if (!id) return;
    setFilter('all');
    setLookupResult(null);
    void lookupAction.run(async (signal) => {
      const result = await services.runtime.tasks.search(id, nextOrder, signal);
      if (signal.aborted) return result;
      setLookupResult(result.data);
      const first = result.data.jobs[0];
      if (first) select(first.id);
      return result;
    }, { pending: '正在查询任务与请求日志…', success: null });
  }
  function toggleOrder() {
    const nextOrder = order === 'desc' ? 'asc' : 'desc';
    setOrder(nextOrder);
    if (query.trim()) lookup(nextOrder);
  }
  const counts: Readonly<Record<string, number>> = {
    all: listedJobs.length,
    active: listedJobs.filter(running).length,
    succeeded: listedJobs.filter((job) => job.status === 'succeeded').length,
    failed: listedJobs.filter((job) => job.status === 'failed').length,
    cancelled: listedJobs.filter((job) => job.status === 'cancelled').length,
  };
  const selectedJob = lookupAction.pending || (lookupResult !== null && !lookupResult.jobs.some((job) => job.id === selected?.id)) ? null : selected;
  const latestProgress = [...events].reverse().find((event) => event.progress)?.progress;
  const progressPercent =
    latestProgress?.total_bytes != null && latestProgress.total_bytes > 0
      ? Math.min(100, Math.round((latestProgress.completed_bytes / latestProgress.total_bytes) * 100))
      : null;
  const elapsedSeconds = selectedJob ? Math.max(0, Date.now() / 1000 - selectedJob.created_at) : 0;
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col" ref={root}>
      <header className="flex shrink-0 items-start justify-between gap-4 px-4 pt-5 lg:px-6">
        <div className="min-w-0">
          <h1 className="text-[24px] font-semibold leading-8 tracking-tight text-[color:var(--text-strong)]">
            任务与日志
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-[color:var(--text-ghost)]">
            <span className="font-mono text-[color:var(--text-muted)]">
              {loaded ? `${visibleJobs.length} / ${listedJobs.length}` : '读取中'}
            </span>
            <span>项</span>
            <span aria-hidden="true" className="h-3 w-px bg-[color:var(--hairline)]" />
            <span>{lookupResult ? '服务器搜索结果' : lookupActive.current ? '按 Enter 搜索服务器日志' : '10 秒自动刷新'}</span>
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={action.pending || lookupAction.pending}
          onClick={() => {
            if (query.trim()) { lookup(); return; }
            void action.run(refresh, { success: '任务列表已更新', pending: '正在刷新任务…' });
          }}
        >
          <RefreshCw aria-hidden="true" />
          刷新
        </Button>
      </header>

      <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 py-3 lg:px-6">
        <div className="w-full max-w-[22rem] [&_input]:h-8 [&_input]:text-[13px]">
          <Input
            id="task-query"
            value={query}
            onChange={(event) => {
              lookupAction.cancel();
              setLookupResult(null);
              setQuery(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); lookup(); }
            }}
            placeholder="关键词 / 任务 ID / 日志 ID，按 Enter 搜索服务器"
            aria-label="按操作名、任务 ID 或日志 ID 查询"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5 lg:ml-auto" role="group" aria-label="状态筛选">
          {filters.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-pressed={filter === entry.id}
              onClick={() => setFilter(entry.id)}
              className={cn(
                'flex items-center gap-1.5 rounded-[6px] px-2.5 py-1 text-[12px] transition-colors',
                filter === entry.id
                  ? 'bg-[color:var(--accent)] font-medium text-[color:var(--primary)]'
                  : 'text-[color:var(--text-muted)] hover:bg-[color:var(--surface-hover)]',
              )}
            >
              {entry.label}
              <span
                className={cn(
                  'font-mono text-[12px]',
                  filter === entry.id
                    ? 'text-[color:var(--primary)]'
                    : 'text-[color:var(--text-ghost)]',
                )}
              >
                {counts[entry.id] ?? 0}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 px-4 pb-4 lg:flex-row lg:px-6">
        <div className="flex min-h-0 w-full flex-1 flex-col overflow-hidden rounded-[10px] bg-[color:var(--surface-sunken)] lg:w-[25rem] lg:flex-none lg:shrink-0">
          <div className="flex shrink-0 items-center justify-between gap-2 px-4 py-2.5">
            <button type="button" aria-label="切换时间排序" onClick={toggleOrder}
              className="text-[12px] font-medium text-[color:var(--text-muted)] hover:text-[color:var(--primary)]">
              任务 · {order === 'desc' ? '时间倒序 ↓' : '时间升序 ↑'}
            </button>
            <span className="font-mono text-[12px] text-[color:var(--text-ghost)]">
              {visibleJobs.length}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {loaded && visibleJobs.length === 0 && (
              <EmptyState
                title={jobs.length === 0 ? '还没有任务记录' : '没有匹配的任务'}
                description={
                  lookupResult ? '请求日志显示在右侧；没有关联任务不代表请求没有发生。' : jobs.length === 0 ? '发起操作后在这里查看进度与结果。' : '调整状态，或输入关键词、完整编号后按 Enter 搜索服务器。'
                }
              />
            )}
            {visibleJobs.map((job) => {
              const current = selectedJob?.id === job.id;
              return (
                <button
                  key={job.id}
                  type="button"
                  title={job.id}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-[6px] px-2.5 py-2 text-left transition-colors',
                    current
                      ? 'bg-[color:var(--card)] shadow-[0_1px_2px_rgb(23_27_36/6%)]'
                      : 'hover:bg-[color:var(--surface-hover)]',
                  )}
                  aria-expanded={current}
                  onClick={() => select(job.id)}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'size-1.5 shrink-0 rounded-full',
                      stateDot[job.status as JobState],
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-[color:var(--text-strong)]">
                    {job.operation}
                  </span>
                  <time
                    className="shrink-0 font-mono text-[12px] text-[color:var(--text-ghost)]"
                    dateTime={new Date(job.created_at).toISOString()}
                  >
                    {new Date(job.created_at).toLocaleTimeString('zh-CN', { hour12: false })}
                  </time>
                  <span
                    className={cn('w-[3.5rem] shrink-0 text-[12px]', stateText[job.status as JobState])}
                  >
                    {taskStates[job.status as JobState]}
                  </span>
                </button>
              );
            })}
            {!lookupActive.current && jobs.length >= limit.current && limit.current < 200 && (
              <div className="flex justify-center px-2 py-2">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={action.pending}
                  onClick={() => {
                    void action.run((signal) => refresh(signal, Math.min(200, limit.current + 50)), {
                      success: '历史任务已更新',
                      pending: '正在读取历史任务…',
                    });
                  }}
                >
                  显示更多历史
                </Button>
              </div>
            )}
          </div>
        </div>

        <section
          aria-label="任务明细"
          className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-[color:var(--hairline)] bg-[color:var(--card)]"
        >
          {lookupResult && <LogRecords result={lookupResult} messages={services.messages} order={order} onOrderChange={toggleOrder} />}
          {selectedJob ? (
            <>
              <div className="shrink-0 px-5 pb-3 pt-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate text-[18px] font-semibold leading-6 text-[color:var(--text-strong)]">
                      {selectedJob.operation}
                    </h2>
                    <div className="mt-1 flex min-w-0 items-center gap-2">
                      <span className="select-text break-all font-mono text-[12px] text-[color:var(--text-ghost)]">
                        {selectedJob.id}
                      </span>
                      <button
                        type="button"
                        onClick={() => void copyTaskId(selectedJob.id)}
                        className="flex shrink-0 items-center gap-1 text-[12px] text-[color:var(--primary)] hover:underline"
                      >
                        <Copy aria-hidden="true" className="size-3" />
                        复制
                      </button>
                    </div>
                  </div>
                  <StateChip status={selectedJob.status as JobState} />
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-[color:var(--text-muted)]">
                  <span className="font-mono">
                    {new Date(selectedJob.created_at).toLocaleString('zh-CN')}
                  </span>
                  {running(selectedJob) && (
                    <span className="font-mono">
                      已运行 {Math.floor(elapsedSeconds)} s
                    </span>
                  )}
                </div>

                {selectedJob.error && (
                  <p className="mt-2 text-[12px] leading-[1.6] text-[color:var(--destructive)]">
                    {selectedJob.error}
                  </p>
                )}

                {progressPercent !== null && latestProgress && (
                  <div className="mt-3">
                    <div className="flex items-baseline justify-between gap-3 text-[12px]">
                      <span className="truncate text-[color:var(--text-muted)]">
                        {formatJobProgress(latestProgress)}
                      </span>
                      <span className="shrink-0 font-mono text-[color:var(--primary)]">
                        {progressPercent}%
                      </span>
                    </div>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[color:var(--surface-sunken)]">
                      <div
                        className="h-full rounded-full bg-[color:var(--primary)]"
                        style={{ width: `${progressPercent}%` }}
                      />
                    </div>
                  </div>
                )}

                {running(selectedJob) && (
                  <div className="mt-3 flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={details.pending}
                      onClick={() => {
                        void details.run(
                          async (signal) => {
                            const response = await services.runtime.tasks.cancel(
                              selectedJob.id,
                              signal,
                            );
                            await refresh(signal);
                            await services.runtime.tasks.select(selectedJob.id, signal);
                            return response;
                          },
                          { success: '已发送任务取消请求', pending: '正在取消任务…' },
                        );
                      }}
                    >
                      <Square aria-hidden="true" />
                      取消任务
                    </Button>
                  </div>
                )}
              </div>

              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto border-t border-[color:var(--hairline)] px-5 pb-5 pt-4">
                <PaperBlock
                  title="任务日志"
                  aside={
                    <button type="button" aria-label="切换任务日志时间排序" onClick={toggleOrder}
                      className="text-[12px] text-[color:var(--text-ghost)] hover:text-[color:var(--primary)]">
                      {events.length} 条 · {order === 'desc' ? '时间倒序 ↓' : '时间升序 ↑'}
                    </button>
                  }
                >
                  {events.length === 0 ? (
                    <p className="text-[12px] text-[color:var(--text-faint)]">没有返回任务事件。</p>
                  ) : (
                    <ol className="space-y-1">
                      {visibleEvents.map((event) => (
                        <li
                          key={event.sequence}
                          className="flex items-baseline gap-2 text-[12px] text-[color:var(--text-body)]"
                        >
                          <time className="shrink-0 font-mono text-[color:var(--text-ghost)]">
                            {new Date(event.timestamp).toLocaleTimeString('zh-CN', {
                              hour12: false,
                            })}
                          </time>
                          <span className={cn('shrink-0', stateText[event.status as JobState])}>
                            {taskStates[event.status as JobState]}
                          </span>
                          {event.progress && (
                            <span className="min-w-0 truncate text-[color:var(--text-muted)]">
                              {formatJobProgress(event.progress)}
                            </span>
                          )}
                        </li>
                      ))}
                    </ol>
                  )}
                </PaperBlock>

                <PaperBlock title="提交内容">
                  <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.6] text-[color:var(--text-body)]">
                    {JSON.stringify(selectedJob.input, null, 2)}
                  </pre>
                </PaperBlock>

                <TaskArtifacts
                  key={selectedJob.id}
                  services={services}
                  value={selectedJob.result}
                  logId={selection.result?.logId ?? null}
                />
                <JsonResult value={selectedJob.result} />
                <p className="text-[12px] leading-[1.6] text-[color:var(--text-faint)]">
                  任务 ID 用于回查任务，日志 ID 用于排查接口请求。取消等待不会撤回已提交的操作。
                </p>
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center px-6">
              <p className="text-[13px] text-[color:var(--text-faint)]">
                {lookupResult?.logs ? '可从左侧选择关联任务，查看任务事件与最终结果。' : '选一条任务，看事件、提交内容与产物。'}
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
