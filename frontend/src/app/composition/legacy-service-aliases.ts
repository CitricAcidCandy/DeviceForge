import { HostError } from '../../plugin-sdk/index.ts';
import type { Dispose, HostContext, ServiceRef } from '../../plugin-sdk/index.ts';
import type { ExtensionRegistry } from '../../plugins/extensions/registry.ts';

export interface LegacyServiceAlias {
  readonly from: ServiceRef;
  readonly to: ServiceRef;
}

/** 只保留旧引用的薄转调；依赖撤销时撤销别名，不启用插件、不创建旧业务模型。 */
export function registerLegacyServiceAliases(
  context: HostContext, registry: Pick<ExtensionRegistry, 'register'>, aliases: readonly LegacyServiceAlias[],
): Dispose {
  const services = context.services;
  if (!services) throw new HostError('protocol', 'services_unavailable', '旧服务兼容需要公开版本化服务能力');
  const releases: Dispose[] = [];
  try {
    for (const alias of aliases) {
      if (alias.from.id === alias.to.id && alias.from.version === alias.to.version)
        throw new Error('旧服务别名不能转调自身');
      releases.push(services.whenAvailable(`legacy-alias.${alias.from.id}`, [alias.to], (feature) =>
        registry.register({ pluginId: 'host', generation: 0, context: feature }, { services: [{
          ...alias.from,
          invoke(input, caller, signal) {
            if (!caller.services) throw new HostError('protocol', 'services_unavailable', '本次兼容调用缺少服务上下文');
            // 必须使用本次调用上下文，保留父调用链、期限、取消与递归预算。
            return caller.services.call(alias.to, input, signal);
          },
        }] })));
    }
  } catch (error) {
    for (const release of releases) void Promise.resolve().then(release).catch(() => undefined);
    throw error;
  }
  return context.onDispose(async () => {
    const results = await Promise.allSettled(releases.map((release) => Promise.resolve().then(release)));
    const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, '旧服务兼容作用域未完全撤销');
  });
}

// 仅列迁移前已经公开的旧名称；新业务服务不加入此兼容表。
export const legacyBusinessAliases: readonly LegacyServiceAlias[] = Object.freeze([
  { from: { id: 'host.ai-sdk', version: '1' }, to: { id: 'deviceforge_ai.sdk', version: '1' } },
  { from: { id: 'host.ai-sdk.stream', version: '1' }, to: { id: 'deviceforge_ai.sdk.stream', version: '1' } },
  { from: { id: 'host.performance', version: '1' }, to: { id: 'deviceforge_performance.api', version: '1' } },
]);
