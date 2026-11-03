import { HostError } from '@deviceforge/plugin-sdk';
import type { Dispose, HostContext } from '@deviceforge/plugin-sdk';
import { abortable } from '@deviceforge/business-kit/api';
import { boundedServiceJson, serviceObject, serviceResult } from './contract.ts';
import type { createAiServiceRuntime } from './runtime.ts';

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
  const lifetime = new AbortController();
  let runtime: ReturnType<typeof createAiServiceRuntime> | null = null, closed = false;
  let loading: Promise<typeof import('./runtime.ts')> | null = null;
  async function current(signal: AbortSignal) {
    const combined = AbortSignal.any([signal, context.signal, lifetime.signal]);
    if (closed || combined.aborted)
      throw new HostError('cancelled', 'ai_public_services_closed', 'AI 公开服务已撤销');
    if (!runtime) {
      loading ??= import('./runtime.ts');
      const module = await abortable(loading, combined);
      combined.throwIfAborted();
      if (closed) throw new HostError('cancelled', 'ai_public_services_closed', 'AI 公开服务已撤销');
      runtime ??= module.createAiServiceRuntime(context);
    }
    return { runtime, signal: combined };
  }
  const refs = aiPublicServiceRefs(pluginId);
  const unregister = register({ services: [
    {
      ...refs.sdk,
      async invoke(value, _caller, signal) {
        const request = serviceObject(boundedServiceJson(value, 1024 * 1024));
        const call = await current(signal);
        return serviceResult(call.runtime.sdk(request, call.signal));
      },
    },
    {
      ...refs.stream,
      async invoke(value, _caller, signal) {
        const request = serviceObject(boundedServiceJson(value, 1024 * 1024, null, true), true);
        const call = await current(signal);
        return serviceResult(call.runtime.stream(request, call.signal), true);
      },
    },
  ] });
  let releasing: Promise<void> | null = null;
  return () => {
    if (!releasing) {
      closed = true;
      lifetime.abort();
      const current = runtime;
      runtime = null;
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
