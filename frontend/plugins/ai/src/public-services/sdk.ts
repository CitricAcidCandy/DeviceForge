import type { HostResult, JsonValue } from '@deviceforge/plugin-sdk';
import {
  normalizeAiSdkAssistant, normalizeAiSdkThread, normalizeAiSdkTurn,
} from '../model/sdk/index.ts';
import type { AiServices } from '../services.ts';
import { invalidServiceRequest, serviceFields } from './contract.ts';

type AiSdk = AiServices['sdk'];
async function ensureOperation(aiSdk: AiSdk, action: string, signal: AbortSignal) {
  if (!aiSdk.snapshot().operations.some((entry) => entry.id === `plugin.ai-sdk.${action}`))
    await aiSdk.refreshOperations(signal);
}
export async function dispatchSdkService(
  model: () => AiSdk, request: Record<string, JsonValue>, signal: AbortSignal,
): Promise<HostResult<unknown>> {
  switch (request.action) {
    case 'runtime.status': {
      serviceFields(request, ['action']);
      const sdk = model();
      await ensureOperation(sdk, request.action, signal);
      return sdk.runtimeStatus(signal);
    }
    case 'sdk.single': {
      serviceFields(request, ['action', 'input']);
      const input = normalizeAiSdkTurn(request.input, false), sdk = model();
      await ensureOperation(sdk, request.action, signal);
      return sdk.single(input, signal);
    }
    case 'sdk.turn': {
      serviceFields(request, ['action', 'input']);
      const input = normalizeAiSdkTurn(request.input, true), sdk = model();
      await ensureOperation(sdk, request.action, signal);
      return sdk.turn(input, signal);
    }
    case 'session.get': {
      serviceFields(request, ['action', 'input']);
      const input = normalizeAiSdkThread(request.input), sdk = model();
      await ensureOperation(sdk, request.action, signal);
      return sdk.getThread(input, signal);
    }
    case 'session.close': {
      serviceFields(request, ['action', 'input']);
      const input = normalizeAiSdkThread(request.input), sdk = model();
      await ensureOperation(sdk, request.action, signal);
      return sdk.closeThread(input, signal);
    }
    case 'assistant.run': {
      serviceFields(request, ['action', 'input']);
      const input = normalizeAiSdkAssistant(request.input), sdk = model();
      await ensureOperation(sdk, request.action, signal);
      return sdk.runAssistant(input, signal);
    }
    default: throw invalidServiceRequest();
  }
}
