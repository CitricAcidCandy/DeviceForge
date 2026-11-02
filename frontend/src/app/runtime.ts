import { createPlatformRuntime } from './platform-runtime.ts';
import type { PlatformRuntimeOptions } from './platform-runtime.ts';
import { createLegacyRuntimeAdapter } from './composition/legacy-runtime.ts';

export interface RuntimeOptions extends PlatformRuntimeOptions {
  /** 旧调用显式选择真实旧服务；默认仍由独立插件提供薄别名目标。 */
  readonly legacyBusinessServices?: boolean;
}

/** 保留旧调用形态；正常产品入口直接使用 createPlatformRuntime。 */
export function createFrontendRuntime(options: RuntimeOptions) {
  const { legacyBusinessServices, ...platformOptions } = options;
  const core = createPlatformRuntime({
    ...platformOptions,
    ...(legacyBusinessServices ? { legacyServiceAliases: false } : {}),
  });
  const adapter = createLegacyRuntimeAdapter(core, { registerServices: legacyBusinessServices === true });
  const runtime = adapter.runtime;
  const closeCore = core.dispose;
  let disposal: Promise<void> | null = null;
  runtime.dispose = (): Promise<void> => {
    if (disposal) return disposal;
    const pending: Promise<void>[] = [];
    // 旧模型先同步撤资格与发起释放，平台随后关闭；两方失败都保留。
    for (const release of [adapter.dispose, closeCore]) {
      try { pending.push(Promise.resolve(release())); }
      catch (error) { pending.push(Promise.reject(error)); }
    }
    disposal = Promise.allSettled(pending).then((results) => {
      const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, '前端兼容运行实例关闭失败');
    });
    return disposal;
  };
  return runtime;
}
