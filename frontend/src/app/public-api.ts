import { HostError } from '../plugin-sdk/index.ts';
import type { HostResult, Job, Operation } from '../plugin-sdk/index.ts';
import { ApiError } from '../shared/api/index.ts';
import type { JobDto, OperationDto } from '../shared/api/index.ts';
import { isJsonValue } from '../plugin-sdk/json.ts';

export function publicOperation(dto: OperationDto): Operation {
  if (!isJsonValue(dto.input_schema)) throw new HostError('protocol', 'invalid_schema', '操作模式不是 JSON 值');
  return { id: dto.id, title: dto.title, input_schema: dto.input_schema };
}
export function publicJob(dto: JobDto): Job {
  const result: unknown = dto.result ?? null;
  if (!isJsonValue(result)) throw new HostError('protocol', 'invalid_result', '任务结果不是 JSON 值');
  return { id: dto.id, operation: dto.operation, status: dto.status, result, error: dto.error ?? null };
}
export async function publicCall<T, U>(request: Promise<HostResult<T>>, map: (value: T) => U): Promise<HostResult<U>> {
  try {
    const result = await request;
    try { return { data: map(result.data), logId: result.logId }; }
    catch (error) {
      if (error instanceof HostError) throw new HostError(error.kind, error.code, error.message, result.logId, error.status, error.retryAfter);
      throw error;
    }
  } catch (error) {
    if (error instanceof ApiError) throw new HostError(error.kind, error.code, error.message, error.logId, error.status, error.retryAfter);
    throw error;
  }
}
