import { useEffect, useRef, useState } from 'react';
import { Copy, RefreshCw, Square } from 'lucide-react';
import { Button } from '../../components/Button/index.tsx';
import { Input } from '../../components/Input/index.tsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/Select/index.tsx';
import type { JobDto, JobEventDto } from '../../services/api/index.ts';
import type { ProductServices } from '../../app/product/services.ts';
import { formatJobProgress } from '../../features/tasks/index.ts';
import { useAction, useSnapshot } from '../../app/product/hooks.ts';
import { EmptyState, JsonResult } from '../../components/index.ts';
import { TaskArtifacts } from './components/TaskArtifacts/index.tsx';
import './workspace.css';

const taskStates = {
  queued: '排队中',
  running: '运行中',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
};
const running = (job: JobDto) => job.status === 'queued' || job.status === 'running';
export function TasksPage({ services }: { services: ProductServices }) {
  const [jobs, setJobs] = useState<readonly JobDto[]>([]);
  const [events, setEvents] = useState<readonly JobEventDto[]>([]);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [loaded, setLoaded] = useState(false);
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
        !refreshState.current.pending &&
        !refreshState.current.error
      ) {
        void action.run(refresh, { quiet: true });
        if (selectedId.current && !detailsPending.current) select(selectedId.current, true);
      }
    }, 10000);
    return () => window.clearInterval(timer);
  }, [services]);
  const visibleJobs = jobs
    .filter(
      (job) =>
        (filter === 'all' || filter === 'active'
          ? filter === 'all' || running(job)
          : job.status === filter) &&
        `${job.operation} ${job.id}`.toLowerCase().includes(query.toLowerCase()),
    )
    .sort(
      (left, right) =>
        Number(running(right)) - Number(running(left)) || right.created_at - left.created_at,
    );
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
    try {
      await navigator.clipboard.writeText(id);
      services.messages.success('任务 ID 已复制');
    } catch {
      services.messages.warning('复制失败，请手动选择任务 ID');
    }
  }
  const selectedJob = selected;
  return (
    <div className="tasks-page" ref={root}>
      <header className="tasks-topline">
        <div className="tasks-topline-main">
          <h1>任务与日志</h1>
          <span className="tasks-topline-meta mono">
            {loaded ? `${visibleJobs.length} / ${jobs.length} 项` : '读取中'} · 10 秒自动刷新
          </span>
        </div>
        <div className="tasks-topline-actions">
          <Button
            variant="ghost"
            size="sm"
            disabled={action.pending}
            onClick={() => {
              void action.run(refresh, { success: '任务列表已更新', pending: '正在刷新任务…' });
            }}
          >
            <RefreshCw aria-hidden="true" />
            刷新
          </Button>
        </div>
      </header>
      <div className="tasks-filters">
        <Input
          id="task-query"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="按操作名或任务 ID 过滤"
          aria-label="过滤任务"
        />
        <Select value={filter} onValueChange={setFilter}>
          <SelectTrigger id="task-filter" aria-label="状态筛选">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部任务</SelectItem>
            <SelectItem value="active">运行与排队</SelectItem>
            <SelectItem value="succeeded">成功</SelectItem>
            <SelectItem value="failed">失败</SelectItem>
            <SelectItem value="cancelled">取消</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="tasks-body">
        <div className="task-list">
          {loaded && visibleJobs.length === 0 && (
            <EmptyState
              title={jobs.length === 0 ? '还没有任务记录' : '没有匹配的任务'}
              description={
                jobs.length === 0 ? '发起操作后在这里查看进度与结果。' : '调整状态或过滤条件。'
              }
            />
          )}
          {visibleJobs.map((job) => (
            <button
              key={job.id}
              type="button"
              className="task-row"
              data-state={job.status}
              data-selected={selectedJob?.id === job.id ? 'true' : undefined}
              aria-expanded={selectedJob?.id === job.id}
              onClick={() => select(job.id)}
            >
              <span className="task-dot" aria-hidden="true" />
              <span className="task-op mono">{job.operation}</span>
              <span className="task-id mono">{job.id}</span>
              <span className={`text-state task-state state-${job.status}`}>
                {taskStates[job.status]}
              </span>
              <time className="task-time mono" dateTime={new Date(job.created_at).toISOString()}>
                {new Date(job.created_at).toLocaleTimeString('zh-CN', { hour12: false })}
              </time>
            </button>
          ))}
          {jobs.length >= limit.current && limit.current < 500 && (
            <div className="task-more">
              <Button
                variant="ghost"
                size="sm"
                disabled={action.pending}
                onClick={() => {
                  void action.run((signal) => refresh(signal, Math.min(500, limit.current + 50)), {
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
        <aside className="task-panel" aria-label="任务明细">
          {selectedJob ? (
            <>
              <div className="task-panel-head">
                <div>
                  <h2 className="mono">{selectedJob.operation}</h2>
                  <p className="mono">{selectedJob.id}</p>
                </div>
                <span className={`text-state state-${selectedJob.status}`}>
                  {taskStates[selectedJob.status]}
                </span>
              </div>
              <div className="task-panel-actions">
                <Button variant="ghost" size="sm" onClick={() => void copyTaskId(selectedJob.id)}>
                  <Copy aria-hidden="true" />
                  复制 ID
                </Button>
                {running(selectedJob) && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={details.pending}
                    onClick={() => {
                      void details.run(
                        async (signal) => {
                          const response = await services.runtime.tasks.cancel(selectedJob.id, signal);
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
                )}
              </div>
              <p className="task-panel-time mono">
                {new Date(selectedJob.created_at).toLocaleString('zh-CN')}
              </p>
              {selectedJob.error && <p className="text-danger task-panel-error">{selectedJob.error}</p>}
              <details className="task-fold" open>
                <summary>任务事件</summary>
                {events.length === 0 ? (
                  <p className="task-hint">没有返回任务事件。</p>
                ) : (
                  <ol className="task-events">
                    {events.map((event) => (
                      <li key={event.sequence}>
                        <time className="mono">
                          {new Date(event.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}
                        </time>
                        <span>{taskStates[event.status]}</span>
                        {event.progress && <span>{formatJobProgress(event.progress)}</span>}
                      </li>
                    ))}
                  </ol>
                )}
              </details>
              <details className="task-fold">
                <summary>提交内容</summary>
                <pre>{JSON.stringify(selectedJob.input, null, 2)}</pre>
              </details>
              <TaskArtifacts
                key={selectedJob.id}
                services={services}
                value={selectedJob.result}
                logId={selection.result?.logId ?? null}
              />
              <JsonResult value={selectedJob.result} />
              <details className="task-fold">
                <summary>任务与日志说明</summary>
                <p className="task-hint">
                  任务 ID 用于回查任务，日志 ID 用于排查接口请求。取消等待不会撤回已提交的操作。
                </p>
              </details>
            </>
          ) : (
            <p className="task-hint task-panel-idle">选一条任务，看事件、提交内容与产物。</p>
          )}
        </aside>
      </div>
    </div>
  );
}
