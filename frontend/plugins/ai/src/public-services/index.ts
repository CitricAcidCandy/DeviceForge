import { HostError } from '@deviceforge/plugin-sdk';
import type { Dispose, HostContext } from '@deviceforge/plugin-sdk';
import { createAiServices } from '../services.ts';
import type { AiServices } from '../services.ts';
import { boundedServiceJson, serviceObject, serviceResult } from './contract.ts';
import { dispatchSdkService } from './sdk.ts';
import { dispatchStreamService } from './stream.ts';

export function aiPublicServiceRefs(pluginId: string) {
  return Object.freeze({
    sdk: Object.freeze({ id: `${pluginId}.sdk`, version: '1' }),
    stream: Object.freeze({ id: `${pluginId}.sdk.stream`, version: '1' }),
  });
}

/** 服务使用专属惰性模型；不借用页面实例，也不向宿主旧服务抢占身份。 */
export function registerAiPublicServices(context: HostContext, pluginId: string): Dispose {
  const register = context.extensions?.register;
  if (!register) throw new Error('AI 公开服务需要动态贡献注册能力');
  let models: AiServices | null = null, closed = false;
  function model() {
    if (closed || context.signal.aborted)
      throw new HostError('cancelled', 'ai_public_services_closed', 'AI 公开服务已撤销');
    models ??= createAiServices(context);
    return models;
  }
  const refs = aiPublicServiceRefs(pluginId);
  const unregister = register({ services: [
    {
      ...refs.sdk,
      invoke(value, _caller, signal) {
        const request = serviceObject(boundedServiceJson(value, 1024 * 1024));
        return serviceResult(dispatchSdkService(() => model().sdk, request, signal));
      },
    },
    {
      ...refs.stream,
      invoke(value, _caller, signal) {
        const request = serviceObject(boundedServiceJson(value, 1024 * 1024, null, true), true);
        return serviceResult(dispatchStreamService(() => model().sdkStreaming, request, signal), true);
      },
    },
  ] });
  let releasing: Promise<void> | null = null;
  return () => {
    if (!releasing) {
      closed = true;
      const current = models;
      models = null;
      releasing = (async () => {
        const results = await Promise.allSettled([unregister(), current?.dispose()]);
        const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
        if (failures.length === 1) throw failures[0];
        if (failures.length) throw new AggregateError(failures, 'AI 公开服务撤销未全部确认');
      })();
    }
    return releasing;
  };
}
