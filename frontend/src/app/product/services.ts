import { createProductPlatformServices } from './platform-services.ts';
import type { ProductPlatformOptions } from './platform-services.ts';
import { createLegacyProductAdapter } from './legacy-services.ts';

export type { ProductConnection } from './platform-services.ts';

/** 仅供旧页面及公开旧工厂兼容；正常产品启动使用纯平台入口。 */
export function createProductServices(
  options: ProductPlatformOptions & { readonly legacyBusinessServices?: boolean },
) {
  const core = createProductPlatformServices({ ...options,
    ...(options.legacyBusinessServices ? { legacyServiceAliases: false } : {}),
  });
  const adapter = createLegacyProductAdapter(core, { registerServices: options.legacyBusinessServices ?? false });
  let closing: Promise<void> | null = null;
  const services = adapter.services;
  services.dispose = (): Promise<void> => {
      if (closing) return closing;
      // 终端等旧资源先同步发起释放，再由平台撤销普通调用资格。
      const legacyRelease = adapter.dispose();
      closing = Promise.allSettled([legacyRelease, core.dispose()]).then((results) => {
        const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
        if (failures.length) throw new AggregateError(failures, '旧产品运行实例清理失败');
      });
      return closing;
  };
  return services;
}
export type ProductServices = ReturnType<typeof createProductServices>;
