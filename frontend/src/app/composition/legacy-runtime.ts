import { HostError } from '../../plugin-sdk/index.ts';
import type { Dispose } from '../../plugin-sdk/index.ts';
import type { PlatformRuntime } from '../platform-runtime.ts';
import { createPluginScope } from '../../plugins/scope.ts';
import { awaitLifecycle, defaultTimeouts } from '../../plugins/lifecycle.ts';
import { createLegacyRuntimeBusiness } from './legacy-runtime-business.ts';
import { legacyBusinessAliases } from './legacy-service-aliases.ts';

/** 旧业务只从显式兼容入口创建；适配器不创建、替换或关闭平台内核。 */
export function createLegacyRuntimeAdapter(
  core: PlatformRuntime, options: { readonly registerServices?: boolean } = {},
) {
  if (core.host.signal.aborted)
    throw new HostError('cancelled', 'legacy_runtime_closed', '平台已关闭，不能挂接旧业务兼容层');
  if (options.registerServices) {
    const aliases = new Set(legacyBusinessAliases.map((alias) => `legacy-alias.${alias.from.id}`));
    if (core.host.services?.diagnostics().some((feature) =>
      aliases.has(feature.featureId) && feature.state !== 'stopped'))
      throw new HostError('protocol', 'legacy_runtime_alias_conflict',
        '登记真实旧服务前必须以 legacyServiceAliases: false 创建平台内核');
  }
  const scope = createPluginScope(core.host);
  const business = createLegacyRuntimeBusiness(core.requestClient);
  let closing: Promise<void> | null = null;
  let disposal: Promise<void> | null = null;
  let unregisterHost: Dispose | null = null;
  function close(): Promise<void> {
    if (closing) return closing;
    scope.close();
    // 先同步发起旧模型释放，再由调用方关闭平台；不创建从未使用的业务。
    const resources = business.dispose();
    const services = awaitLifecycle(() => scope.dispose(), undefined,
      Date.now() + defaultTimeouts.cleanupMs, '旧运行时服务清理');
    closing = Promise.allSettled([resources, services]).then((results) => {
      const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, '旧运行时兼容层释放失败');
    });
    return closing;
  }
  function dispose(): Promise<void> {
    if (disposal) return disposal;
    const resources = close();
    const unregister = unregisterHost;
    unregisterHost = null;
    let removed: void | Promise<void>;
    try { removed = unregister?.(); }
    catch (error) { removed = Promise.reject(error); }
    disposal = Promise.allSettled([resources, removed]).then((results) => {
      const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, '旧运行时适配器关闭失败');
    });
    return disposal;
  }
  unregisterHost = core.host.onDispose(() => {
    unregisterHost = null;
    return close();
  });
  try {
    if (options.registerServices) business.register(core.webPlugins.extensions, scope.context);
  } catch (error) {
    void dispose().catch(() => undefined);
    throw error;
  }
  return {
    runtime: {
      ...core,
      get aiSdk() { return business.aiSdk; },
      get aiSdkStreaming() { return business.aiSdkStreaming; },
      get performance() { return business.performance; },
    },
    dispose,
  };
}
