import type { Job, JsonValue } from '@deviceforge/plugin-sdk';
import { ApiError } from '@deviceforge/plugin-sdk';
import type { JobGateway } from '@deviceforge/business-kit/jobs';
import { isJsonData } from '@deviceforge/business-kit/jobs';
import type { ApiClient, JobDto } from './types.ts';
import { cancelEndpoint, jobEndpoint, submitEndpoint } from './endpoints.ts';

export function publicJob(value: Pick<JobDto, 'id' | 'operation' | 'status' | 'result' | 'error'>, logId: string | null = null): Job {
  const result = value.result ?? null;
  if (!isJsonData(result)) throw new ApiError('protocol', 'invalid_marketplace_job', '管理任务结果不是有限 JSON', null, logId);
  return {
    id: value.id, operation: value.operation, status: value.status,
    result, error: value.error ?? null,
  };
}
export function createHttpJobGateway(client: ApiClient): JobGateway {
  const call = async (pending: Promise<{ data: JobDto; logId: string | null }>) => {
    const result = await pending;
    return { data: publicJob(result.data, result.logId), logId: result.logId };
  };
  return {
    submit: (operation, input: JsonValue, signal) => call(client.call(submitEndpoint, { operation, input }, signal)),
    getJob: (id, signal) => call(client.call(jobEndpoint, id, signal)),
    cancelJob: (id, signal) => call(client.call(cancelEndpoint, id, signal)),
  };
}
