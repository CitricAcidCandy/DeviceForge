import type { ApiResult, EventQuery, JobEventDto } from '../../../services/api/index.ts';
import type { JobGateway, JobTicket, TaskRecord } from '../../../shared/jobs/index.ts';
import type { ResourceSnapshot } from '../../../shared/lifecycle/latest.ts';

export interface AiTaskGateway extends JobGateway {
  readonly getEvents: (
    id: string,
    query: EventQuery,
    signal: AbortSignal,
  ) => Promise<ApiResult<JobEventDto[]>>;
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
