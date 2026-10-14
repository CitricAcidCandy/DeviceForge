import { HostError } from '../plugin-sdk/index.ts';
import type { HostContext, JsonValue } from '../plugin-sdk/index.ts';
import {
  normalizeMirroringControl,
  normalizeStreamInput,
} from '../features/mirroring-streaming/index.ts';
import type {
  createMirroringStreaming,
  MirroringOutputOptions,
  MirroringPacketOutputResult,
  MirroringStreamingSnapshot,
} from '../features/mirroring-streaming/index.ts';
import type { ApiError, ApiResult } from '../services/api/index.ts';
import { isJsonData } from '../shared/jobs/index.ts';
import type { ExtensionRegistry } from '../plugins/extensions/registry.ts';
import { publicCall } from './public-api.ts';

type Streaming = ReturnType<typeof createMirroringStreaming>;
const encoder = new TextEncoder();
function invalidRequest(): HostError {
  return new HostError(
    'protocol',
    'invalid_mirroring_service_request',
    '投屏直播服务请求不符合动作与参数契约',
  );
}
function boundedJson(value: unknown, maximum: number): JsonValue {
  if (!isJsonData(value))
    throw new HostError(
      'protocol',
      'invalid_mirroring_service_json',
      '投屏直播服务仅接受有限 JSON 数据',
    );
  if (encoder.encode(JSON.stringify(value)).length > maximum)
    throw new HostError('protocol', 'mirroring_service_limit', '投屏直播服务 JSON 超过限额');
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
function readOptions(value: Record<string, JsonValue>): MirroringOutputOptions {
  fields(value, ['action', 'limit']);
  if (Object.hasOwn(value, 'limit') && typeof value.limit !== 'number') throw invalidRequest();
  return typeof value.limit === 'number' ? { limit: value.limit } : {};
}
function errorValue(value: ApiError | undefined) {
  return value === undefined
    ? null
    : {
        kind: value.kind,
        code: value.code,
        message: value.message,
        logId: value.logId,
        status: value.status,
        retryAfter: value.retryAfter,
      };
}
function snapshotValue(value: MirroringStreamingSnapshot) {
  return {
    ...value,
    errors: Object.fromEntries(
      Object.entries(value.errors).map(([action, error]) => [action, errorValue(error)]),
    ),
  };
}
function packetValue(value: MirroringPacketOutputResult) {
  return {
    ...value,
    mediaPackets: value.mediaPackets.map((packet) =>
      packet.kind === 'video' || packet.kind === 'audio'
        ? { ...packet, bytes: Array.from(packet.bytes) }
        : packet,
    ),
  };
}
async function dispatch(
  streaming: Streaming,
  request: Record<string, JsonValue>,
  signal: AbortSignal,
): Promise<ApiResult<unknown>> {
  switch (request.action) {
    case 'definitions':
      fields(request, ['action']);
      return streaming.refreshDefinitions(signal);
    case 'open':
      fields(request, ['action', 'input']);
      return streaming.open(normalizeStreamInput(request.input), signal);
    case 'resume': {
      fields(request, ['action', 'id']);
      if (typeof request.id !== 'string') throw invalidRequest();
      return streaming.resume(request.id, signal);
    }
    case 'output':
      return streaming.readOutput(readOptions(request), signal);
    case 'packets': {
      const result = await streaming.readPackets(readOptions(request), signal);
      return { data: packetValue(result.data), logId: result.logId };
    }
    case 'poll':
      return streaming.pollOutput(readOptions(request), signal);
    case 'control':
      fields(request, ['action', 'input']);
      return streaming.sendControl(normalizeMirroringControl(request.input), signal);
    case 'eof':
      fields(request, ['action']);
      return streaming.eof(signal);
    case 'cancel':
      fields(request, ['action']);
      return streaming.cancel(signal);
    case 'snapshot':
      fields(request, ['action']);
      return { data: snapshotValue(streaming.snapshot()), logId: null };
    default:
      throw invalidRequest();
  }
}
export function registerMirroringStreamingService(
  registry: ExtensionRegistry,
  context: HostContext,
  streaming: Streaming,
) {
  return registry.register(
    { pluginId: 'host', generation: 0, context },
    {
      services: [
        {
          id: 'host.mirroring.stream',
          version: '1',
          invoke: (value, _context, signal) => {
            const request = object(boundedJson(value, 16 * 1024));
            return publicCall(
              dispatch(streaming, request, AbortSignal.any([signal, context.signal])),
              (data) =>
                boundedJson(data, request.action === 'packets' ? 32 * 1024 * 1024 : 1024 * 1024),
            );
          },
        },
      ],
    },
  );
}
