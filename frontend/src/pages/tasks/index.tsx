import { useEffect, useRef, useState } from 'react';
import { RefreshCw, Square, ChevronDown, Copy } from 'lucide-react';
import { Button } from '../../components/Button/index.tsx';
import { Input } from '../../components/Input/index.tsx';
import { Label } from '../../components/Label/index.tsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/Select/index.tsx';
import type { JobDto, JobEventDto } from '../../services/api/index.ts';
import type { ProductServices } from '../../app/product/services.ts';
import { useAction, useSnapshot } from '../../app/product/hooks.ts';
import { EmptyState, JsonResult, PageTitle } from '../../components/index.ts';
import { ActionFeedback } from '../../app/product/feedback.tsx';
import { TaskArtifacts } from './components/TaskArtifacts/index.tsx';

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
  const [copyState, setCopyState] = useState('');
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
    void action.run(refresh);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !root.current?.closest('[hidden]')) {
        void action.run(refresh);
        if (selectedId.current && !detailsPending.current) select(selectedId.current);
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
  function select(id: string) {
    void details.run(async (signal) => {
      const [job, updates] = await Promise.all([
        services.runtime.tasks.select(id, signal),
        services.runtime.tasks.events(id, {}, signal),
      ]);
      if (!signal.aborted) setEvents(updates.data);
      return job;
    });
  }
  return (
    <div className="product-page" ref={root}>
      <PageTitle
        eyebrow="WORKSHOP / ACTIVITY"
        title="任务与日志"
        description="正在发生的操作，以及每一次真实结果。"
      >
        <Button
          variant="outline"
          disabled={action.pending}
          onClick={() => {
            void action.run(refresh);
          }}
        >
          <RefreshCw />
          刷新任务
        </Button>
      </PageTitle>
      <div className="form-row task-filters">
        <div className="form-field">
          <Label htmlFor="task-filter">任务状态</Label>
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger id="task-filter">
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
        <div className="form-field grow">
          <Label htmlFor="task-query">操作名或任务 ID</Label>
          <Input
            id="task-query"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="筛选已加载任务"
          />
        </div>
      </div>
      <ActionFeedback {...action} />
      {loaded && visibleJobs.length === 0 && (
        <EmptyState
          title={jobs.length === 0 ? '还没有任务记录' : '没有匹配的任务'}
          description={
            jobs.length === 0
              ? '从任一工具发起操作后，可以在这里查看进度、结果和排查信息。'
              : '调整状态或操作名筛选。'
          }
        />
      )}
      <div className="task-list">
        {visibleJobs.map((job) => (
          <article
            className={`task-row${selected?.id === job.id ? ' is-expanded' : ''}`}
            key={job.id}
          >
            <div className="task-summary">
              <Button
                className="task-name"
                variant="ghost"
                onClick={() => select(job.id)}
                aria-expanded={selected?.id === job.id}
              >
                <ChevronDown />
                <span>
                  {job.operation}
                  <small className="mono">{job.id}</small>
                </span>
              </Button>
              <time dateTime={new Date(job.created_at).toISOString()}>
                {new Date(job.created_at).toLocaleString('zh-CN')}
              </time>
              <span className={`text-state state-${job.status}`}>{taskStates[job.status]}</span>
              {running(job) && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={details.pending}
                  onClick={() => {
                    void details.run(async (signal) => {
                      const response = await services.runtime.tasks.cancel(job.id, signal);
                      await refresh(signal);
                      await services.runtime.tasks.select(job.id, signal);
                      return response;
                    });
                  }}
                >
                  <Square />
                  取消任务
                </Button>
              )}
            </div>
            {selected?.id === job.id && (
              <div className="task-detail">
                <ActionFeedback {...details} />
                <div className="section-heading">
                  <p>实际状态：{taskStates[selected.status]}</p>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      void navigator.clipboard.writeText(selected.id).then(
                        () => setCopyState('任务 ID 已复制'),
                        () => setCopyState('复制失败，请手动选择任务 ID'),
                      );
                    }}
                  >
                    <Copy />
                    复制任务 ID
                  </Button>
                </div>
                <span role="status">{copyState}</span>
                {selected.error && <p className="text-danger">{selected.error}</p>}
                <details open>
                  <summary>任务事件</summary>
                  {events.length === 0 ? (
                    <p className="muted">没有返回任务事件。</p>
                  ) : (
                    <ol className="task-events">
                      {events.map((event) => (
                        <li key={event.sequence}>
                          <time>{new Date(event.timestamp).toLocaleTimeString('zh-CN')}</time>
                          <span>{taskStates[event.status]}</span>
                        </li>
                      ))}
                    </ol>
                  )}
                </details>
                <details>
                  <summary>提交内容</summary>
                  <pre>{JSON.stringify(selected.input, null, 2)}</pre>
                </details>
                <TaskArtifacts
                  key={selected.id}
                  services={services}
                  value={selected.result}
                  logId={selection.result?.logId ?? null}
                />
                <JsonResult value={selected.result} />
                <p className="muted">
                  任务 ID 用于回查任务；日志 ID
                  用于排查一次接口请求。取消等待不会撤回已经提交的操作。
                </p>
              </div>
            )}
          </article>
        ))}
      </div>
      {jobs.length >= limit.current && limit.current < 500 && (
        <Button
          className="load-more"
          variant="outline"
          disabled={action.pending}
          onClick={() => {
            void action.run((signal) => refresh(signal, Math.min(500, limit.current + 50)));
          }}
        >
          显示更多历史
        </Button>
      )}
    </div>
  );
}
