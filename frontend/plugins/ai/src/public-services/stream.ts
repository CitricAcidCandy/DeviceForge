import type { ApiError, HostResult, JsonValue } from '@deviceforge/plugin-sdk';
import type {
  AiSdkStreamInput, AiSdkStreamOwner, AiSdkStreamReadOptions, AiSdkStreamingSnapshot,
} from '../model/sdk-stream/index.ts';
import type { AiServices } from '../services.ts';
import { invalidServiceRequest, serviceFields, serviceObject } from './contract.ts';

function owner(value: JsonValue | undefined): AiSdkStreamOwner {
  const data = serviceObject(value, true);
  serviceFields(data, ['project_id', 'thread_id'], true);
  if (typeof data.project_id !== 'string' ||
      (Object.hasOwn(data, 'thread_id') && typeof data.thread_id !== 'string'))
    throw invalidServiceRequest(true);
  return { project_id: data.project_id,
    ...(typeof data.thread_id === 'string' ? { thread_id: data.thread_id } : {}) };
}
function input(value: JsonValue | undefined): AiSdkStreamInput {
  const data = serviceObject(value, true);
  serviceFields(data, ['project_id', 'prompt', 'thread_id'], true);
  if (typeof data.prompt !== 'string') throw invalidServiceRequest(true);
  return {
    ...owner({ project_id: data.project_id ?? null,
      ...(Object.hasOwn(data, 'thread_id') ? { thread_id: data.thread_id ?? null } : {}) }),
    prompt: data.prompt,
  };
}
function readOptions(value: Record<string, JsonValue>): AiSdkStreamReadOptions {
  serviceFields(value, ['action', 'limit'], true);
  if (Object.hasOwn(value, 'limit') && typeof value.limit !== 'number') throw invalidServiceRequest(true);
  return typeof value.limit === 'number' ? { limit: value.limit } : {};
}
function errorValue(error: ApiError | null) {
  return error === null ? null : { kind: error.kind, code: error.code, message: error.message,
    logId: error.logId, status: error.status, retryAfter: error.retryAfter };
}
function snapshotValue(value: AiSdkStreamingSnapshot) {
  const errors = Object.fromEntries(Object.entries(value.errors)
    .map(([action, error]) => [action, errorValue(error ?? null)]));
  return { ...value, terminalError: errorValue(value.terminalError), errors };
}
export async function dispatchStreamService(
  model: () => AiServices['sdkStreaming'], request: Record<string, JsonValue>, signal: AbortSignal,
): Promise<HostResult<unknown>> {
  switch (request.action) {
    case 'open': {
      serviceFields(request, ['action', 'input'], true);
      const value = input(request.input);
      return model().open(value, signal);
    }
    case 'resume': {
      serviceFields(request, ['action', 'id', 'owner'], true);
      if (typeof request.id !== 'string') throw invalidServiceRequest(true);
      const value = owner(request.owner);
      return model().resume(request.id, value, signal);
    }
    case 'output': return model().readOutput(readOptions(request), signal);
    case 'poll': return model().pollOutput(readOptions(request), signal);
    case 'definitions':
      serviceFields(request, ['action'], true);
      return model().refreshDefinitions(signal);
    case 'records':
      serviceFields(request, ['action'], true);
      return model().refreshRecords(signal);
    case 'query':
      serviceFields(request, ['action'], true);
      return model().query(signal);
    case 'cancel':
      serviceFields(request, ['action'], true);
      return model().cancel(signal);
    case 'clear': {
      serviceFields(request, ['action'], true);
      const streaming = model();
      streaming.clear();
      return { data: snapshotValue(streaming.snapshot()), logId: null };
    }
    case 'snapshot':
      serviceFields(request, ['action'], true);
      return { data: snapshotValue(model().snapshot()), logId: null };
    default: throw invalidServiceRequest(true);
  }
}
