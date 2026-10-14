import { ApiError } from '../../../services/api/index.ts';
import type { EventQuery, JobEventDto } from '../../../services/api/index.ts';
import { isJobEvent, isRecord } from '../../../services/api/validation.ts';
import type { JobTicket } from '../../../shared/jobs/index.ts';

const operations = new Set(
  ['runtime.status', 'cli.single', 'cli.turn', 'session.get', 'session.close'].map(
    (action) => `plugin.ai-assistant.${action}`,
  ),
);
function natural(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
export function requireAiTaskTicket(value: JobTicket): JobTicket {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !value.id.trim() ||
    value.id === '.' ||
    value.id === '..' ||
    !operations.has(value.operation) ||
    (value.submitLogId !== null && typeof value.submitLogId !== 'string')
  ) {
    throw new ApiError('protocol', 'invalid_ai_ticket', '任务观测需要有效的 AI 助手票据');
  }
  return Object.freeze({
    id: value.id,
    operation: value.operation,
    submitLogId: value.submitLogId,
  });
}
export function requireAiEventQuery(value: EventQuery): EventQuery {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== 'after') ||
    (value.after !== undefined && !natural(value.after))
  ) {
    throw new ApiError('protocol', 'invalid_ai_task_query', '任务事件游标须为非负安全整数');
  }
  return Object.freeze(value.after === undefined ? {} : { after: value.after });
}
export function decodeAiTaskEvents(
  value: readonly JobEventDto[],
  ticket: JobTicket,
  after: number,
  logId: string | null,
): readonly Readonly<JobEventDto>[] {
  if (!Array.isArray(value))
    throw new ApiError('protocol', 'invalid_ai_task_events', '任务事件必须为数组', null, logId);
  let previous = after;
  const events = value.map((row) => {
    if (
      !isJobEvent(row) ||
      row.job_id !== ticket.id ||
      !natural(row.sequence) ||
      row.sequence <= previous ||
      !natural(row.timestamp)
    ) {
      throw new ApiError(
        'protocol',
        'invalid_ai_task_events',
        '任务事件的归属、递增序号或时间不符合公开契约',
        null,
        logId,
      );
    }
    previous = row.sequence;
    return Object.freeze({ ...row });
  });
  return Object.freeze(events);
}
