import { HostError } from '@deviceforge/plugin-sdk';
import type { HostContext, JsonValue } from '@deviceforge/plugin-sdk';
import { createAiServices } from '../services.ts';
import type { AiServices } from '../services.ts';
import { dispatchSdkService } from './sdk.ts';
import { dispatchStreamService } from './stream.ts';

/** 按需载入原服务模型与派发规则，模型归属仍由原AI清理契约管理。 */
export function createAiServiceRuntime(context: HostContext) {
  let models: AiServices | null = null, closed = false;
  function model() {
    if (closed || context.signal.aborted)
      throw new HostError('cancelled', 'ai_public_services_closed', 'AI 公开服务已撤销');
    models ??= createAiServices(context);
    return models;
  }
  return {
    sdk: (request: Record<string, JsonValue>, signal: AbortSignal) => dispatchSdkService(() => model().sdk, request, signal),
    stream: (request: Record<string, JsonValue>, signal: AbortSignal) => dispatchStreamService(() => model().sdkStreaming, request, signal),
    dispose() {
      if (closed) return;
      closed = true;
      const current = models;
      models = null;
      return current?.dispose();
    },
  };
}
