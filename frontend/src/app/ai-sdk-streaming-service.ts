import { HostError } from '../plugin-sdk/index.ts';
import type { HostContext, JsonValue } from '../plugin-sdk/index.ts';
import type {
  createAiSdkStreaming,
  AiSdkStreamInput,
  AiSdkStreamOwner,
  AiSdkStreamingSnapshot,
  AiSdkStreamReadOptions,
} from '../features/ai-sdk-streaming/index.ts';
import type { ApiError, ApiResult } from '../services/api/index.ts';
import { isJsonData } from '../shared/jobs/values.ts';
import type { ExtensionRegistry } from '../plugins/extensions/registry.ts';
import { publicCall } from './public-api.ts';

type Streaming = ReturnType<typeof createAiSdkStreaming>;
const encoder = new TextEncoder();
function invalidRequest(): HostError {
  return new HostError(
    'protocol',
    'invalid_ai_sdk_service_request',
    'SDK实时服务请求不符合动作与参数契约',
  );
}
function boundedJson(value: unknown, maximum: number, logId: string | null = null): JsonValue {
  if (!isJsonData(value))
    throw new HostError(
      'protocol',
      'invalid_ai_sdk_service_json',
      'SDK实时服务仅接受有限JSON数据',
      logId,
    );
  if (encoder.encode(JSON.stringify(value)).length > maximum)
    throw new HostError('protocol', 'ai_sdk_service_limit', 'SDK实时服务JSON超过限额', logId);
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
function owner(value: JsonValue | undefined): AiSdkStreamOwner {
  const data = object(value);
  fields(data, ['project_id', 'thread_id']);
  if (
    typeof data.project_id !== 'string' ||
    (Object.hasOwn(data, 'thread_id') && typeof data.thread_id !== 'string')
  )
    throw invalidRequest();
  return {
    project_id: data.project_id,
    ...(typeof data.thread_id === 'string' ? { thread_id: data.thread_id } : {}),
  };
}
function input(value: JsonValue | undefined): AiSdkStreamInput {
  const data = object(value);
  fields(data, ['project_id', 'prompt', 'thread_id']);
  if (typeof data.prompt !== 'string') throw invalidRequest();
  return {
    ...owner({
      project_id: data.project_id ?? null,
      ...(Object.hasOwn(data, 'thread_id') ? { thread_id: data.thread_id ?? null } : {}),
    }),
    prompt: data.prompt,
  };
}
function readOptions(value: Record<string, JsonValue>): AiSdkStreamReadOptions {
  fields(value, ['action', 'limit']);
  if (Object.hasOwn(value, 'limit') && typeof value.limit !== 'number') throw invalidRequest();
  return typeof value.limit === 'number' ? { limit: value.limit } : {};
}
function errorValue(error: ApiError | null) {
  return error === null
    ? null
    : {
        kind: error.kind,
        code: error.code,
        message: error.message,
        logId: error.logId,
        status: error.status,
        retryAfter: error.retryAfter,
      };
}
function snapshotValue(value: AiSdkStreamingSnapshot) {
  const errors = Object.fromEntries(
    Object.entries(value.errors).map(([action, error]) => [action, errorValue(error ?? null)]),
  );
  return { ...value, terminalError: errorValue(value.terminalError), errors };
}
async function dispatch(
  streaming: Streaming,
  request: Record<string, JsonValue>,
  signal: AbortSignal,
): Promise<ApiResult<unknown>> {
  switch (request.action) {
    case 'open':
      fields(request, ['action', 'input']);
      return streaming.open(input(request.input), signal);
    case 'resume': {
      fields(request, ['action', 'id', 'owner']);
      if (typeof request.id !== 'string') throw invalidRequest();
      return streaming.resume(request.id, owner(request.owner), signal);
    }
    case 'output':
      return streaming.readOutput(readOptions(request), signal);
    case 'poll':
      return streaming.pollOutput(readOptions(request), signal);
    case 'definitions':
      fields(request, ['action']);
      return streaming.refreshDefinitions(signal);
    case 'records':
      fields(request, ['action']);
      return streaming.refreshRecords(signal);
    case 'query':
      fields(request, ['action']);
      return streaming.query(signal);
    case 'cancel':
      fields(request, ['action']);
      return streaming.cancel(signal);
    case 'clear':
      fields(request, ['action']);
      streaming.clear();
      return { data: snapshotValue(streaming.snapshot()), logId: null };
    case 'snapshot':
      fields(request, ['action']);
      return { data: snapshotValue(streaming.snapshot()), logId: null };
    default:
      throw invalidRequest();
  }
}
export function registerAiSdkStreamingService(
  registry: ExtensionRegistry,
  context: HostContext,
  streaming: Streaming,
) {
  return registry.register(
    { pluginId: 'host', generation: 0, context },
    {
      services: [
        {
          id: 'host.ai-sdk.stream',
          version: '1',
          invoke: (value, _context, signal) => {
            const request = object(boundedJson(value, 1024 * 1024));
            return publicCall(dispatch(streaming, request, signal), (data) =>
              boundedJson(data, 32 * 1024 * 1024),
            );
          },
        },
      ],
    },
  );
}
