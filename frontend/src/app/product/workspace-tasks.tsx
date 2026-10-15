import { useEffect, useMemo, useState } from 'react';
import { ChevronUp, ChevronDown, Copy, ListChecks, RefreshCw } from 'lucide-react';
import { Button } from '../../components/Button/index.tsx';
import { EmptyState, JsonResult } from '../../components/index.ts';
import { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter, SheetClose } from '../../components/Sheet/index.tsx';
import type { ApiResult, JobDto, JobEventDto } from '../../services/api/index.ts';
import { ErrorNotice } from './feedback.tsx';
import { useSnapshot } from './hooks.ts';
import type { ProductServices } from './services.ts';
import { PRODUCT_ROUTES } from './routes.ts';
import type { ProductRoute } from './routes.ts';
import { taskBelongsToRoute, taskStateLabels } from './task-scope.ts';
import { usePageTasks } from './use-page-tasks.ts';
import './workspace-tasks.css';

export function WorkspaceTasks({ services, route, onNavigate }: {
  services: ProductServices;
  route: ProductRoute;
  onNavigate(route: ProductRoute): void;
}) {
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const history = usePageTasks(services, open);
  const devices = useSnapshot(services.runtime.devices);
  const operations = useSnapshot(services.runtime.operations);
  const deviceOperations = useMemo(() => new Set(devices.providers.flatMap((provider) => [
    provider.definition.discoverOperation,
    ...provider.definition.capabilities.map((capability) => capability.operation),
  ])), [devices.providers]);
  const jobs = history.jobs
    .filter((job) => taskBelongsToRoute(job.operation, route, deviceOperations))
    .sort((left, right) => right.created_at - left.created_at);
  const activeCount = jobs.filter((job) => job.status === 'queued' || job.status === 'running').length;
  const latest = jobs[0];
  const pageLabel = PRODUCT_ROUTES.find((entry) => entry.id === route)?.label ?? '当前页面';
  const operationTitle = (operation: string) => operations.result?.data.find((entry) => entry.id === operation)?.title ?? operation;
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <footer className="workspace-taskbar" aria-label="当前页面任务记录">
        <SheetTrigger asChild>
          <Button variant="ghost" className="workspace-task-trigger">
            <ListChecks aria-hidden="true" />
            <span>{route === 'tasks' ? '全部任务记录' : '当前页任务'}</span>
            {activeCount > 0 && <span className="workspace-task-count">{activeCount} 进行中</span>}
            <small>{history.error ? '记录读取失败' : latest ? `${operationTitle(latest.operation)} · ${taskStateLabels[latest.status]}` : history.loaded ? '暂无记录' : '正在读取…'}</small>
            <ChevronUp aria-hidden="true" />
          </Button>
        </SheetTrigger>
      </footer>
      <SheetContent side="bottom" className="workspace-task-tray">
        <SheetHeader>
          <div className="task-tray-heading">
            <SheetTitle>{route === 'tasks' ? '全部任务记录' : `${pageLabel} · 任务记录`}</SheetTitle>
            <Button variant="ghost" size="sm" disabled={history.pending} onClick={() => void history.refresh()}>
              <RefreshCw aria-hidden="true" />刷新
            </Button>
          </div>
          <SheetDescription>{route === 'tasks' ? '全部页面的任务' : '仅显示本页面相关任务'} · {jobs.length} 条{history.jobs.length >= 500 ? ' · 最近 500 条中筛选' : ''}</SheetDescription>
        </SheetHeader>
        <div className="task-tray-scroll" aria-label="任务记录列表" tabIndex={0}>
          <ErrorNotice error={history.error} />
          {history.loaded && jobs.length === 0 && <EmptyState title="当前没有相关任务" description="此页面的任务会显示在这里。" />}
          {!history.loaded && !history.error && <p className="muted" role="status">正在读取任务…</p>}
          {jobs.map((job) => (
            <article className="task-tray-record" key={job.id}>
              <Button className="task-tray-summary" variant="ghost" aria-expanded={selectedId === job.id} onClick={() => setSelectedId((current) => current === job.id ? null : job.id)}>
                <ChevronDown aria-hidden="true" />
                <span className="task-tray-operation">{operationTitle(job.operation)}<small className="mono">{job.id}</small></span>
                <time dateTime={new Date(job.created_at).toISOString()}>{new Date(job.created_at).toLocaleString('zh-CN')}</time>
                <span className={`text-state state-${job.status}`}>{taskStateLabels[job.status]}</span>
              </Button>
              {selectedId === job.id && <TrayTaskDetails key={job.id} services={services} job={job} />}
            </article>
          ))}
        </div>
        <SheetFooter>
          {route !== 'tasks' && <Button variant="outline" onClick={() => { setOpen(false); onNavigate('tasks'); }}>前往任务与日志</Button>}
          <SheetClose asChild><Button variant="ghost">收起</Button></SheetClose>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function TrayTaskDetails({ services, job }: { services: ProductServices; job: JobDto }) {
  const [result, setResult] = useState<ApiResult<JobDto> | null>(null);
  const [events, setEvents] = useState<readonly JobEventDto[]>([]);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      services.runtime.tasks.get(job.id, controller.signal),
      services.runtime.tasks.events(job.id, {}, controller.signal),
    ]).then(([response, updates]) => {
      if (!controller.signal.aborted) { setResult(response); setEvents(updates.data); }
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setError(failure);
    });
    return () => controller.abort();
  }, [services, job.id, job.status]);
  const current = result?.data ?? job;
  const copyId = async () => {
    try { await navigator.clipboard.writeText(job.id); services.messages.success('任务 ID 已复制'); }
    catch { services.messages.warning('复制失败，请手动选择任务 ID'); }
  };
  return (
    <div className="task-tray-detail">
      <Button size="sm" variant="ghost" onClick={() => void copyId()}><Copy aria-hidden="true" />复制任务 ID</Button>
      <ErrorNotice error={error} />
      {result?.logId && <p className="log-id">日志 ID：{result.logId}</p>}
      {current.error && <p className="text-danger" role="alert">{current.error}</p>}
      <details><summary>任务事件 · {events.length}</summary><ol className="task-events">{events.map((event) => <li key={event.sequence}><time>{new Date(event.timestamp).toLocaleTimeString('zh-CN')}</time><span>{taskStateLabels[event.status]}</span></li>)}</ol></details>
      <details><summary>提交内容</summary><pre>{JSON.stringify(current.input, null, 2)}</pre></details>
      <JsonResult value={current.result} />
    </div>
  );
}
