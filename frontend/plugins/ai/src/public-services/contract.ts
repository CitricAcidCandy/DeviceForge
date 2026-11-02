import { ApiError, HostError } from '@deviceforge/plugin-sdk';
import type { HostResult, JsonValue } from '@deviceforge/plugin-sdk';
import { isJsonData } from '@deviceforge/business-kit/jobs';

const encoder = new TextEncoder();
export function invalidServiceRequest(stream = false) {
  return new HostError('protocol', 'invalid_ai_sdk_service_request',
    stream ? 'SDK实时服务请求不符合动作与参数契约' : 'SDK服务请求不符合动作与参数契约');
}
export function boundedServiceJson(
  value: unknown, maximum: number, logId: string | null = null, stream = false,
): JsonValue {
  const prefix = stream ? 'SDK实时服务' : 'SDK服务';
  if (!isJsonData(value))
    throw new HostError('protocol', 'invalid_ai_sdk_service_json', `${prefix}仅接受有限JSON数据`, logId);
  if (encoder.encode(JSON.stringify(value)).length > maximum)
    throw new HostError('protocol', 'ai_sdk_service_limit', `${prefix}JSON超过限额`, logId);
  return structuredClone(value);
}
export function serviceObject(value: JsonValue | undefined, stream = false): Record<string, JsonValue> {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value))
    throw invalidServiceRequest(stream);
  return value;
}
export function serviceFields(value: Record<string, JsonValue>, allowed: readonly string[], stream = false) {
  if (Object.keys(value).some((name) => !allowed.includes(name))) throw invalidServiceRequest(stream);
}
export async function serviceResult(
  request: Promise<HostResult<unknown>>, stream = false,
): Promise<HostResult<JsonValue>> {
  try {
    const result = await request;
    try {
      return { data: boundedServiceJson(result.data, 32 * 1024 * 1024, result.logId, stream),
        logId: result.logId };
    } catch (error) {
      if (error instanceof HostError)
        throw new HostError(error.kind, error.code, error.message, result.logId, error.status, error.retryAfter);
      throw error;
    }
  } catch (error) {
    if (error instanceof ApiError)
      throw new HostError(error.kind, error.code, error.message, error.logId, error.status, error.retryAfter);
    // JobWaitFailure 保留原任务票据、提交日志及 cause，不能压成一次新请求。
    throw error;
  }
}
