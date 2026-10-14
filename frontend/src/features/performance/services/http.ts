import { HostError } from '../../../plugin-sdk/index.ts';
import type { HostResult, Job } from '../../../plugin-sdk/index.ts';
import type { ApiClient, ApiResult } from '../../../services/api/index.ts';
import { createHttpJobGateway, isJsonData } from '../../../shared/jobs/index.ts';
import type { TaskRecord } from '../../../shared/jobs/index.ts';
import type { PerformanceGateway } from '../types/index.ts';

async function publicResponse(request: Promise<ApiResult<TaskRecord>>): Promise<HostResult<Job>> {
  const response = await request;
  const result: unknown = response.data.result ?? null;
  if (!isJsonData(result)) throw new HostError('protocol', 'invalid_performance_job', '性能任务结果不是有限 JSON 数据', response.logId);
  return {
    data: { id: response.data.id, operation: response.data.operation, status: response.data.status, result, error: response.data.error ?? null },
    logId: response.logId,
  };
}

export function createHttpPerformanceGateway(client: ApiClient): PerformanceGateway {
  const gateway = createHttpJobGateway(client);
  return {
    submit: (operation, input, signal) => publicResponse(gateway.submit(operation, input, signal)),
    getJob: (id, signal) => publicResponse(gateway.getJob(id, signal)),
  };
}
