import { HostError } from '../plugin-sdk/index.ts';
import type { HostContext, HostResult, JsonValue } from '../plugin-sdk/index.ts';
import { isPerformanceStart } from '../features/performance/index.ts';
import type { Performance, PerformanceOutcome } from '../features/performance/index.ts';
import { isJsonData } from '../shared/jobs/index.ts';
import type { ExtensionRegistry } from '../plugins/extensions/registry.ts';
import { publicCall } from './public-api.ts';

const encoder = new TextEncoder();

function invalidRequest(): HostError {
  return new HostError(
    'protocol',
    'invalid_performance_service_request',
    '性能服务请求不符合动作与参数契约',
  );
}

function boundedJson(value: unknown, maximum: number): JsonValue {
  if (!isJsonData(value))
    throw new HostError(
      'protocol',
      'invalid_performance_service_json',
      '性能服务仅接受有限 JSON 数据',
    );
  if (encoder.encode(JSON.stringify(value)).length > maximum)
    throw new HostError('protocol', 'performance_service_limit', '性能服务 JSON 超过限额');
  return structuredClone(value);
}

function object(value: JsonValue | undefined): Record<string, JsonValue> {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value))
    throw invalidRequest();
  return value;
}

function fields(value: Record<string, JsonValue>, allowed: readonly string[]): void {
  if (Object.keys(value).some((name) => !allowed.includes(name))) throw invalidRequest();
}

function sessionId(input: Record<string, JsonValue>): string {
  if (typeof input.session_id !== 'string') throw invalidRequest();
  return input.session_id;
}

async function publicOutcome<T>(request: Promise<PerformanceOutcome<T>>): Promise<HostResult<T>> {
  const response = await request;
  return { data: response.data, logId: response.logId };
}

async function dispatch(
  performance: Performance,
  request: Record<string, JsonValue>,
  signal: AbortSignal,
): Promise<HostResult<unknown>> {
  if (request.action === 'capabilities') {
    fields(request, ['action']);
    return publicOutcome(performance.capabilities(signal));
  }
  fields(request, ['action', 'input']);
  const input = object(request.input);
  switch (request.action) {
    case 'start':
      if (!isPerformanceStart(input)) throw invalidRequest();
      return publicOutcome(performance.start(input, signal));
    case 'inspect':
    case 'pause':
    case 'resume':
    case 'stop':
      fields(input, ['session_id']);
      return publicOutcome(performance[request.action](sessionId(input), signal));
    case 'samples':
      fields(input, ['session_id', 'after', 'limit']);
      if (typeof input.after !== 'number' || typeof input.limit !== 'number')
        throw invalidRequest();
      return publicOutcome(
        performance.samples(sessionId(input), { after: input.after, limit: input.limit }, signal),
      );
    case 'list':
      fields(input, ['after_id', 'limit']);
      if (
        typeof input.limit !== 'number' ||
        (Object.hasOwn(input, 'after_id') &&
          input.after_id !== null &&
          typeof input.after_id !== 'string')
      )
        throw invalidRequest();
      return publicOutcome(
        performance.list(
          {
            afterId: typeof input.after_id === 'string' ? input.after_id : null,
            limit: input.limit,
          },
          signal,
        ),
      );
    default:
      throw invalidRequest();
  }
}

export function registerPerformanceService(
  registry: ExtensionRegistry,
  context: HostContext,
  performance: Performance,
) {
  return registry.register(
    { pluginId: 'host', generation: 0, context },
    {
      services: [
        {
          id: 'host.performance',
          version: '1',
          invoke: (value, _context, signal) => {
            const request = object(boundedJson(value, 16 * 1024));
            return publicCall(dispatch(performance, request, signal), (data) =>
              boundedJson(data, 4 * 1024 * 1024),
            );
          },
        },
      ],
    },
  );
}
