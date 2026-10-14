import { HostError } from '../plugin-sdk/index.ts';
import type { HostContext, HostResult, JsonValue } from '../plugin-sdk/index.ts';
import type { createAiSdk } from '../features/ai-sdk/index.ts';
import {
  normalizeAiSdkAssistant,
  normalizeAiSdkThread,
  normalizeAiSdkTurn,
} from '../features/ai-sdk/index.ts';
import type {
  AiSdkAssistantInput,
  AiSdkSingleInput,
  AiSdkThreadInput,
  AiSdkTurnInput,
} from '../features/ai-sdk/index.ts';
import type { JobOutcome } from '../shared/jobs/index.ts';
import { isJsonData } from '../shared/jobs/values.ts';
import type { ExtensionRegistry } from '../plugins/extensions/registry.ts';
import { publicCall } from './public-api.ts';

type AiSdk = ReturnType<typeof createAiSdk>;
const encoder = new TextEncoder();

function invalidRequest(): HostError {
  return new HostError(
    'protocol',
    'invalid_ai_sdk_service_request',
    'SDK服务请求不符合动作与参数契约',
  );
}

function boundedJson(value: unknown, maximum: number, logId: string | null = null): JsonValue {
  if (!isJsonData(value))
    throw new HostError(
      'protocol',
      'invalid_ai_sdk_service_json',
      'SDK服务仅接受有限JSON数据',
      logId,
    );
  if (encoder.encode(JSON.stringify(value)).length > maximum)
    throw new HostError('protocol', 'ai_sdk_service_limit', 'SDK服务JSON超过限额', logId);
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

function singleInput(value: JsonValue | undefined): AiSdkSingleInput {
  return normalizeAiSdkTurn(value, false);
}

function turnInput(value: JsonValue | undefined): AiSdkTurnInput {
  return normalizeAiSdkTurn(value, true);
}

function threadInput(value: JsonValue | undefined): AiSdkThreadInput {
  return normalizeAiSdkThread(value);
}

function assistantInput(value: JsonValue | undefined): AiSdkAssistantInput {
  return normalizeAiSdkAssistant(value);
}

async function publicOutcome<T>(request: Promise<JobOutcome<T>>): Promise<HostResult<T>> {
  const result = await request;
  return { data: result.data, logId: result.logId };
}

async function ensureOperation(aiSdk: AiSdk, action: string, signal: AbortSignal): Promise<void> {
  const id = 'plugin.ai-sdk.' + action;
  if (!aiSdk.snapshot().operations.some((entry) => entry.id === id))
    await aiSdk.refreshOperations(signal);
}

async function dispatch(
  aiSdk: AiSdk,
  request: Record<string, JsonValue>,
  signal: AbortSignal,
): Promise<HostResult<unknown>> {
  if (typeof request.action !== 'string') throw invalidRequest();
  if (
    ![
      'runtime.status',
      'sdk.single',
      'sdk.turn',
      'session.get',
      'session.close',
      'assistant.run',
    ].includes(request.action)
  )
    throw invalidRequest();
  switch (request.action) {
    case 'runtime.status':
      fields(request, ['action']);
      await ensureOperation(aiSdk, request.action, signal);
      return publicOutcome(aiSdk.runtimeStatus(signal));
    case 'sdk.single': {
      fields(request, ['action', 'input']);
      const input = singleInput(request.input);
      await ensureOperation(aiSdk, request.action, signal);
      return publicOutcome(aiSdk.single(input, signal));
    }
    case 'sdk.turn': {
      fields(request, ['action', 'input']);
      const input = turnInput(request.input);
      await ensureOperation(aiSdk, request.action, signal);
      return publicOutcome(aiSdk.turn(input, signal));
    }
    case 'session.get': {
      fields(request, ['action', 'input']);
      const input = threadInput(request.input);
      await ensureOperation(aiSdk, request.action, signal);
      return publicOutcome(aiSdk.getThread(input, signal));
    }
    case 'session.close': {
      fields(request, ['action', 'input']);
      const input = threadInput(request.input);
      await ensureOperation(aiSdk, request.action, signal);
      return publicOutcome(aiSdk.closeThread(input, signal));
    }
    case 'assistant.run': {
      fields(request, ['action', 'input']);
      const input = assistantInput(request.input);
      await ensureOperation(aiSdk, request.action, signal);
      return publicOutcome(aiSdk.runAssistant(input, signal));
    }
    default:
      throw invalidRequest();
  }
}

export function registerAiSdkService(
  registry: ExtensionRegistry,
  context: HostContext,
  aiSdk: AiSdk,
) {
  return registry.register(
    { pluginId: 'host', generation: 0, context },
    {
      services: [
        {
          id: 'host.ai-sdk',
          version: '1',
          invoke: (value, _context, signal) => {
            const request = object(boundedJson(value, 1024 * 1024));
            return publicCall(dispatch(aiSdk, request, signal), (data) =>
              boundedJson(data, 32 * 1024 * 1024),
            );
          },
        },
      ],
    },
  );
}
