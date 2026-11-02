import { createHttpAiSdk } from '../../features/ai-sdk/index.ts';
import { createHttpAiSdkStreaming } from '../../features/ai-sdk-streaming/index.ts';
import { createHttpPerformance } from '../../features/performance/index.ts';
import type { ApiClient } from '../../services/api/index.ts';
import type { HostContext } from '../../plugin-sdk/index.ts';
import { HostError } from '../../plugin-sdk/index.ts';
import type { ExtensionRegistry } from '../../plugins/extensions/registry.ts';
import { registerAiSdkService } from '../ai-sdk-service.ts';
import { registerAiSdkStreamingService } from '../ai-sdk-streaming-service.ts';
import { registerPerformanceService } from '../performance-service.ts';
import { createLazyProductResources } from '../product/lazy-resources.ts';

/** 旧工厂访问器的显式兼容层，默认产品服务登记不使用这些模型。 */
export function createLegacyRuntimeBusiness(client: ApiClient) {
  const resources = createLazyProductResources();
  let closed = false;
  const current = () => { if (closed) throw new HostError('cancelled', 'legacy_runtime_closed', '旧运行时业务访问已撤销'); };
  function lazy<T>(name: string, create: () => T, release: (value: T) => void): () => T {
    const first = resources.lazy(name, create, release);
    let cached: { readonly value: T } | null = null;
    return () => {
      // 已创建对象保留原方法的关闭错误语义，但绝不在关闭后补建旧模型。
      if (cached) return cached.value;
      current();
      cached = { value: first() };
      return cached.value;
    };
  }
  const aiSdk = lazy('aiSdk', () => createHttpAiSdk(client), (value) => value.dispose());
  const aiSdkStreaming = lazy('aiSdkStreaming', () => createHttpAiSdkStreaming(client), (value) => value.dispose());
  const performance = lazy('performance', () => createHttpPerformance(client), (value) => value.dispose());
  return {
    get aiSdk() { return aiSdk(); },
    get aiSdkStreaming() { return aiSdkStreaming(); },
    get performance() { return performance(); },
    register(registry: ExtensionRegistry, context: HostContext) {
      context.onDispose(registerAiSdkService(registry, context, aiSdk()));
      context.onDispose(registerAiSdkStreamingService(registry, context, aiSdkStreaming()));
      context.onDispose(registerPerformanceService(registry, context, performance()));
    },
    snapshot: resources.snapshot,
    dispose() { closed = true; return resources.dispose(); },
  };
}
