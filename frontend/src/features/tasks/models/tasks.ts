import {
  cancelEndpoint,
  eventsEndpoint,
  jobEndpoint,
  jobsEndpoint,
  submitEndpoint,
} from '../../../services/api/index.ts';
import type { ApiClient, EventQuery, JobDto, JobQuery, LogOrder } from '../../../services/api/index.ts';
import { createLatestResource } from '../../../shared/lifecycle/latest.ts';
import type { Dispose, TaskHistoryAccess, TaskHistoryChange, TaskSubmission } from '../../../plugin-sdk/index.ts';
import { lookupTask, searchTasks } from './log-search.ts';

export interface TasksOptions {
  readonly subscribeChanges?: NonNullable<TaskHistoryAccess['subscribeChanges']>;
}
export function createTasks(
  client: ApiClient,
  beforeSubmit?: (input: TaskSubmission, signal: AbortSignal) => Promise<TaskSubmission>,
  options: TasksOptions = {},
) {
  const resource = createLatestResource<JobDto>();
  const lifetime = new AbortController();
  const subscriptions = new Set<Dispose>();
  let closed = false;
  function subscribeChanges(listener: (change: TaskHistoryChange) => void): Dispose {
    if (closed) return () => undefined;
    let live = true;
    let upstream: Dispose | undefined;
    const notify = (change: TaskHistoryChange) => {
      if (!live || closed) return;
      try { listener(change); } catch { /* 单个消费者不能中断其他任务通知。 */ }
    };
    const release = () => {
      if (!live) return;
      live = false;
      subscriptions.delete(release);
      try { void Promise.resolve(upstream?.()).catch(() => undefined); }
      catch { /* 释放失败只属于当前订阅，其他资源仍须回收。 */ }
    };
    subscriptions.add(release);
    try { upstream = options.subscribeChanges?.(notify); }
    catch { notify({ state: 'unavailable', revision: null, reset: true }); }
    // 上游可能同步通知，并在回调中触发整个任务用例的销毁。
    if (!live) {
      try { void Promise.resolve(upstream?.()).catch(() => undefined); }
      catch { /* 同步回调中的释放仍须局部收敛。 */ }
    }
    return release;
  }
  const combined = (signal: AbortSignal) =>
    closed ? AbortSignal.abort() : AbortSignal.any([signal, lifetime.signal]);
  const get = (id: string, signal: AbortSignal, requestClient: ApiClient = client) => requestClient.call(jobEndpoint, id, combined(signal));
  async function submit(input: TaskSubmission, signal: AbortSignal, requestClient: ApiClient = client) {
    const current = combined(signal);
    const transformed = beforeSubmit ? await beforeSubmit(input, current) : input;
    return requestClient.call(submitEndpoint, transformed, current);
  }
  return {
    ...(options.subscribeChanges ? { subscribeChanges } : {}),
    lookup: (id: string, signal: AbortSignal) => lookupTask(client, id, combined(signal)),
    search: (query: string, order: LogOrder, signal: AbortSignal) => searchTasks(client, query, combined(signal), order),
    list: (query: JobQuery, signal: AbortSignal) =>
      client.call(jobsEndpoint, query, combined(signal)),
    submit,
    get,
    cancel: (id: string, signal: AbortSignal, requestClient: ApiClient = client) => requestClient.call(cancelEndpoint, id, combined(signal)),
    events: (id: string, query: EventQuery, signal: AbortSignal) =>
      client.call(eventsEndpoint, { id, query }, combined(signal)),
    select: (id: string, signal: AbortSignal) =>
      resource.run((current) => get(id, current), signal),
    snapshot: resource.snapshot,
    subscribe: resource.subscribe,
    dispose() {
      if (closed) return;
      closed = true;
      for (const release of [...subscriptions]) void release();
      resource.dispose();
      lifetime.abort();
    },
  };
}
export type Tasks = ReturnType<typeof createTasks>;
