import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, ChevronUp, Copy, RefreshCw } from 'lucide-react';
import { Button } from '../../components/Button/index.tsx';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '../../components/Sheet/index.tsx';
import { JsonResult } from '../../components/index.ts';
import type { ApiResult, JobDto, JobEventDto } from '../../services/api/index.ts';
import { ErrorNotice } from './feedback.tsx';
import { useSnapshot } from './hooks.ts';
import type { ProductServices } from './services.ts';
import { PRODUCT_ROUTES } from './routes.ts';
import type { ProductRoute } from './routes.ts';
import { taskBelongsToRoute, taskStateLabels } from './task-scope.ts';
import type { usePageTasks } from './use-page-tasks.ts';
import './workspace-tasks.css';

type DockFilter = 'active' | 'failed' | 'all';

const filters: readonly { id: DockFilter; label: string }[] = [
  { id: 'active', label: '进行中' },
  { id: 'failed', label: '失败' },
  { id: 'all', label: '全部' },
];

/*
 * 任务不再常驻右栏占地：底部一行文本报状态，点它从下往上弹出抽屉。
 * 常驻的只有「几个进行中 / 几条记录」，要看细节才展开。
 */
export function WorkspaceTasks({
  services, route, onNavigate, history, activeCount,
}: {
  services: ProductServices;
  route: ProductRoute;
  onNavigate(route: ProductRoute): void;
  history: ReturnType<typeof usePageTasks>;
  activeCount: number;
}) {
  // 没有进行中的任务时默认给「全部」：点开抽屉是来看记录的，不是来看空列表。
  const [filter, setFilter] = useState<DockFilter | null>(null);
  const effectiveFilter = filter ?? (activeCount > 0 ? 'active' : 'all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const operations = useSnapshot(services.runtime.operations);
  const devices = useSnapshot(services.runtime.devices);
  const deviceOperations = useMemo(
    () =>
      new Set(
        devices.providers.flatMap((provider) => [
          provider.definition.discoverOperation,
          ...provider.definition.capabilities.map((capability) => capability.operation),
        ]),
      ),
    [devices.providers],
  );
  const scoped = history.jobs
    .filter((job) => taskBelongsToRoute(job.operation, route, deviceOperations))
    .sort((left, right) => right.created_at - left.created_at);
  const failedCount = scoped.filter((job) => job.status === 'failed').length;
  const jobs = scoped.filter((job) => {
    if (effectiveFilter === 'all') return true;
    if (effectiveFilter === 'failed') return job.status === 'failed';
    return job.status === 'queued' || job.status === 'running';
  });
  const pageLabel = PRODUCT_ROUTES.find((entry) => entry.id === route)?.label ?? '当前页面';
  const operationTitle = (operation: string) =>
    operations.result?.data.find((entry) => entry.id === operation)?.title ?? operation;
  const emptyText = history.error
    ? '任务记录读取失败'
    : !history.loaded
      ? '正在读取任务…'
      : effectiveFilter === 'active'
        ? '当前页面没有进行中的任务'
        : effectiveFilter === 'failed'
          ? '没有失败记录'
          : '当前页面还没有任务记录';
  return (
    <>
      <button
        type="button"
        className="dock-strip"
        data-state={activeCount > 0 ? 'active' : 'idle'}
        aria-expanded={open}
        aria-controls="task-drawer"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="dock-strip-label">任务</span>
        <span className="dock-strip-state">
          {activeCount > 0 ? `${activeCount} 进行中` : '空闲'}
        </span>
        {failedCount > 0 ? <span className="dock-strip-failed">{failedCount} 失败</span> : null}
        <span className="dock-strip-meta mono">{scoped.length} 条记录</span>
        <ChevronUp className="dock-strip-caret" aria-hidden="true" />
      </button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="dock-sheet" id="task-drawer">
          <SheetHeader className="dock-sheet-head">
            <SheetTitle>{route === 'tasks' ? '全部任务' : `${pageLabel} · 任务`}</SheetTitle>
            <SheetDescription className="sr-only">
              按创建时间倒序，只列当前页面相关的任务。
            </SheetDescription>
            {activeCount > 0 ? (
              <span className="dock-count">{activeCount} 进行中</span>
            ) : (
              <span className="dock-count is-idle">空闲</span>
            )}
            <div className="dock-filters" role="group" aria-label="任务筛选">
              {filters.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className="dock-filter"
                  aria-pressed={effectiveFilter === entry.id}
                  onClick={() => setFilter(entry.id)}
                >
                  {entry.label}
                </button>
              ))}
              <Button
                variant="ghost"
                size="icon"
                className="dock-refresh"
                disabled={history.pending}
                onClick={() => void history.refresh()}
                aria-label="刷新任务记录"
                title="刷新任务记录"
              >
                <RefreshCw aria-hidden="true" />
              </Button>
            </div>
          </SheetHeader>
          <div className="dock-scroll" tabIndex={0} aria-label="任务列表">
            <ErrorNotice error={history.error} />
            {jobs.length === 0 ? (
              <p className="dock-empty">{emptyText}</p>
            ) : (
              jobs.map((job) => (
                <DockTask
                  key={job.id}
                  services={services}
                  job={job}
                  title={operationTitle(job.operation)}
                  expanded={selectedId === job.id}
                  onToggle={() => setSelectedId((current) => (current === job.id ? null : job.id))}
                />
              ))
            )}
          </div>
          <div className="dock-foot">
            <span>{scoped.length} 条记录</span>
            {route !== 'tasks' ? (
              <Button variant="ghost" size="sm" className="dock-foot-link" onClick={() => onNavigate('tasks')}>
                任务与日志<ArrowUpRight aria-hidden="true" />
              </Button>
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

function DockTask({
  services, job, title, expanded, onToggle,
}: {
  services: ProductServices;
  job: JobDto;
  title: string;
  expanded: boolean;
  onToggle(): void;
}) {
  const running = job.status === 'running' || job.status === 'queued';
  return (
    <article className="dock-task">
      <button type="button" className="dock-task-head" aria-expanded={expanded} onClick={onToggle}>
        <span className="dock-task-title">{title}</span>
        <span className="dock-task-state" data-state={job.status}>{taskStateLabels[job.status]}</span>
      </button>
      {/* 服务端未提供进度百分比，进行中只给不确定的细线，不编造比例。 */}
      {running && <span className="dock-meter" aria-hidden="true"><i /></span>}
      <span className="dock-task-meta">
        {job.id} · {new Date(job.created_at).toLocaleTimeString('zh-CN')}
      </span>
      {expanded && <DockTaskDetails services={services} job={job} />}
    </article>
  );
}

function DockTaskDetails({ services, job }: { services: ProductServices; job: JobDto }) {
  const [result, setResult] = useState<ApiResult<JobDto> | null>(null);
  const [events, setEvents] = useState<readonly JobEventDto[]>([]);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      services.runtime.tasks.get(job.id, controller.signal),
      services.runtime.tasks.events(job.id, {}, controller.signal),
    ]).then(([response, updates]) => {
      if (!controller.signal.aborted) {
        setResult(response);
        setEvents(updates.data);
        setError(null);
      }
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setError(failure);
    });
    return () => controller.abort();
  }, [services, job]);
  const current = result?.data ?? job;
  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(job.id);
      services.messages.success('任务 ID 已复制');
    } catch {
      services.messages.warning('复制失败，请手动选择任务 ID');
    }
  };
  return (
    <div className="dock-task-detail">
      <ErrorNotice error={error} />
      {current.error && <p className="dock-task-error" role="alert">{current.error}</p>}
      <div className="dock-task-detail-actions">
        <Button size="sm" variant="ghost" onClick={() => void copyId()}>
          <Copy aria-hidden="true" />复制 ID
        </Button>
        {result?.logId && <span className="dock-task-detail-log">日志 {result.logId}</span>}
      </div>
      <details>
        <summary>事件 · {events.length}</summary>
        <ol className="dock-task-events">
          {events.map((event) => (
            <li key={event.sequence}>
              <time>{new Date(event.timestamp).toLocaleTimeString('zh-CN')}</time>
              <span>{taskStateLabels[event.status]}</span>
            </li>
          ))}
        </ol>
      </details>
      <details>
        <summary>提交内容</summary>
        <pre>{JSON.stringify(current.input, null, 2)}</pre>
      </details>
      <JsonResult value={current.result} />
    </div>
  );
}
