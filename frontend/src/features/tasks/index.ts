import { cancelEndpoint, eventsEndpoint, jobEndpoint, jobsEndpoint, submitEndpoint } from '../../shared/api/index.ts';
import type { ApiClient, EventQuery, JobDto, JobQuery } from '../../shared/api/index.ts';
import { createLatestResource } from '../../shared/lifecycle/latest.ts';
import type { TaskSubmission } from '../../plugin-sdk/index.ts';

export function createTasks(client: ApiClient, beforeSubmit?: (input: TaskSubmission, signal: AbortSignal) => Promise<TaskSubmission>) {
  const resource = createLatestResource<JobDto>();
  const lifetime = new AbortController();
  let closed = false;
  const combined = (signal: AbortSignal) => closed ? AbortSignal.abort() : AbortSignal.any([signal, lifetime.signal]);
  const get = (id: string, signal: AbortSignal) => client.call(jobEndpoint, id, combined(signal));
  async function submit(input: TaskSubmission, signal: AbortSignal) {
    const current = combined(signal);
    const transformed = beforeSubmit ? await beforeSubmit(input, current) : input;
    return client.call(submitEndpoint, transformed, current);
  }
  return {
    list: (query: JobQuery, signal: AbortSignal) => client.call(jobsEndpoint, query, combined(signal)),
    submit,
    get,
    cancel: (id: string, signal: AbortSignal) => client.call(cancelEndpoint, id, combined(signal)),
    events: (id: string, query: EventQuery, signal: AbortSignal) => client.call(eventsEndpoint, { id, query }, combined(signal)),
    select: (id: string, signal: AbortSignal) => resource.run((current) => get(id, current), signal),
    snapshot: resource.snapshot,
    subscribe: resource.subscribe,
    dispose() { closed = true; resource.dispose(); lifetime.abort(); },
  };
}
export type Tasks = ReturnType<typeof createTasks>;
