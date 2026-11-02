import { HostError } from '@deviceforge/plugin-sdk';
import type { HostContext, HostResult, JsonValue } from '@deviceforge/plugin-sdk';
import { isRecord } from '@deviceforge/business-kit/api';
import { isJsonData } from '@deviceforge/business-kit/jobs';
import { createPublicGateway } from '@deviceforge/business-kit/platform';
import { createPerformance } from './performance/index.ts';
import { isPerformanceStart } from './performance/utils/results.ts';

type Performance = ReturnType<typeof createPerformance>;
function invalidRequest(): HostError {
  return new HostError('protocol', 'invalid_performance_service_request', '性能服务请求不符合动作与参数契约');
}
function boundedJson(value: unknown, maximum: number): JsonValue {
  if (!isJsonData(value))
    throw new HostError('protocol', 'invalid_performance_service_json', '性能服务仅接受有限 JSON 数据');
  if (new TextEncoder().encode(JSON.stringify(value)).length > maximum)
    throw new HostError('protocol', 'performance_service_limit', '性能服务 JSON 超过限额');
  return structuredClone(value);
}
function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw invalidRequest();
  return value;
}
function fields(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw invalidRequest();
}
function sessionId(value: Record<string, unknown>): string {
  if (typeof value.session_id !== 'string') throw invalidRequest();
  return value.session_id;
}
function dispatch(
  performance: () => Performance,
  request: Record<string, unknown>,
  signal: AbortSignal,
): Promise<HostResult<unknown>> {
  const action = request.action;
  if (action === 'capabilities') {
    fields(request, ['action']);
    return performance().capabilities(signal);
  }
  fields(request, ['action', 'input']);
  const input = object(request.input);
  if (action === 'start') {
    if (!isPerformanceStart(input)) throw invalidRequest();
    return performance().start(input, signal);
  }
  if (action === 'inspect' || action === 'pause' || action === 'resume' || action === 'stop') {
    fields(input, ['session_id']);
    return performance()[action](sessionId(input), signal);
  }
  if (action === 'samples') {
    fields(input, ['session_id', 'after', 'limit']);
    if (typeof input.after !== 'number' || typeof input.limit !== 'number') throw invalidRequest();
    return performance().samples(sessionId(input), { after: input.after, limit: input.limit }, signal);
  }
  if (action === 'list') {
    fields(input, ['after_id', 'limit']);
    if (typeof input.limit !== 'number' ||
        (input.after_id !== undefined && input.after_id !== null && typeof input.after_id !== 'string'))
      throw invalidRequest();
    return performance().list({ afterId: typeof input.after_id === 'string' ? input.after_id : null,
      limit: input.limit }, signal);
  }
  throw invalidRequest();
}

/** 服务模型仅属于插件作用域，不复用任何已挂载视图的状态或请求。 */
export function registerPerformancePublicService(context: HostContext, pluginId: string): void {
  const extensions = context.extensions;
  if (!extensions?.register) throw new HostError('protocol', 'extension_access_unavailable', '性能插件需要公开服务登记能力');
  const lifetime = new AbortController();
  let model: Performance | null = null, closed = false;
  function current(signal: AbortSignal) {
    if (closed || signal.aborted) throw new HostError('cancelled', 'performance_service_revoked', '性能服务作用域已撤销');
  }
  function performance(): Performance {
    model ??= createPerformance(createPublicGateway(context));
    return model;
  }
  const release = extensions.register({ services: [{
    id: `${pluginId}.api`, version: '1',
    async invoke(value, _context, signal) {
      const combined = AbortSignal.any([signal, context.signal, lifetime.signal]);
      current(combined);
      const request = object(boundedJson(value, 16 * 1024));
      const response = await dispatch(performance, request, combined);
      current(combined);
      try {
        return { data: boundedJson(response.data, 4 * 1024 * 1024), logId: response.logId };
      } catch (error) {
        // 输出限额失败属于本次已返回结果，保留该结果的日志，不借其他请求补齐。
        if (error instanceof HostError) throw new HostError(error.kind, error.code, error.message,
          response.logId, error.status, error.retryAfter);
        throw error;
      }
    },
  }] });
  context.onDispose(() => {
    if (closed) return;
    closed = true;
    lifetime.abort();
    model?.dispose();
    model = null;
    return release();
  });
}
