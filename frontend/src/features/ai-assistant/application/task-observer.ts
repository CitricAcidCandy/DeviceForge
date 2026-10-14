import { ApiError } from '../../../shared/api/index.ts';
import type { ApiResult, EventQuery, JobEventDto } from '../../../shared/api/index.ts';
import { abortable } from '../../../shared/api/abort.ts';
import { createJobRunner } from '../../../shared/jobs/index.ts';
import type { JobGateway, JobTicket, TaskRecord } from '../../../shared/jobs/index.ts';
import { createLatestResource } from '../../../shared/lifecycle/latest.ts';
import type { ResourceSnapshot } from '../../../shared/lifecycle/latest.ts';
import { decodeAiTaskEvents, requireAiEventQuery, requireAiTaskTicket } from '../domain/task-event-rules.ts';

export interface AiTaskGateway extends JobGateway {
  readonly getEvents: (id: string, query: EventQuery, signal: AbortSignal) => Promise<ApiResult<JobEventDto[]>>;
}
export interface AiTaskObservation {
  readonly ticket: JobTicket;
  readonly job: Readonly<TaskRecord>;
  readonly events: readonly Readonly<JobEventDto>[];
  readonly after: number;
  readonly jobLogId: string | null;
  readonly eventsLogId: string | null;
}
export type AiTaskSnapshot = ResourceSnapshot<AiTaskObservation>;

export function createAiTaskObserver(gateway: AiTaskGateway) {
  const jobs = createJobRunner(gateway);
  const resource = createLatestResource<AiTaskObservation>();
  let selected: JobTicket | null = null;
  let closed = false;
  function snapshot(value = resource.snapshot()): AiTaskSnapshot {
    const previous = value.result?.data.ticket;
    return previous && (previous.id !== selected?.id || previous.operation !== selected?.operation)
      ? { ...value, result: null } : value;
  }
  function active(signal: AbortSignal, logId: string | null = null): void {
    if (closed || signal.aborted) throw new ApiError('cancelled', 'cancelled', 'AI 任务观测等待已取消', null, logId);
  }
  return {
    async select(value: JobTicket, query: EventQuery, signal: AbortSignal): Promise<ApiResult<AiTaskObservation>> {
      active(signal);
      const ticket = requireAiTaskTicket(value);
      const parameters = requireAiEventQuery(query);
      selected = ticket;
      return resource.run(async (current) => {
        const job = await jobs.query(ticket, current);
        active(current, job.logId);
        const pending = Promise.resolve().then(() => {
          active(current, job.logId);
          return gateway.getEvents(ticket.id, parameters, current);
        });
        let reply: ApiResult<JobEventDto[]>;
        try { reply = await abortable(pending, current); }
        catch (error) {
          if (current.aborted) throw new ApiError('cancelled', 'cancelled', 'AI 任务事件等待已取消', null, job.logId);
          throw error;
        }
        active(current, reply.logId);
        const events = decodeAiTaskEvents(reply.data, ticket, parameters.after ?? 0, reply.logId);
        const observation: AiTaskObservation = Object.freeze({
          ticket, job: Object.freeze({ ...job.data }), events,
          after: events.at(-1)?.sequence ?? parameters.after ?? 0,
          jobLogId: job.logId, eventsLogId: reply.logId,
        });
        return Object.freeze({ data: observation, logId: reply.logId });
      }, signal);
    },
    snapshot: () => snapshot(),
    subscribe(listener: (value: AiTaskSnapshot) => void): () => void {
      return resource.subscribe((value) => listener(snapshot(value)));
    },
    dispose() {
      closed = true;
      resource.dispose();
      jobs.dispose();
    },
  };
}
