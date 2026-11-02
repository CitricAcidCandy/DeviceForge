import { HostError } from '../plugin-sdk/models.ts';
import type { CleanupCallback, CleanupContext, CleanupRegistration } from '../plugin-sdk/cleanup.ts';
import type { Dispose } from '../plugin-sdk/models.ts';
import type { PluginTransport } from '../plugin-sdk/transport.ts';
import { awaitLifecycle, defaultTimeouts } from '../plugins/lifecycle.ts';
import { scopedTransportAccess } from '../plugins/transport-access.ts';

export interface PluginCleanupOptions {
  readonly signal: AbortSignal;
  readonly onDispose: (dispose: Dispose) => Dispose;
  readonly transport?: PluginTransport;
  readonly timeoutMs?: number;
}

/** 复用原客户端和资源追踪，只给已登记的清理回调一个独立、限时的请求窗口。 */
export function createPluginCleanup(options: PluginCleanupOptions): CleanupRegistration {
  const timeout = options.timeoutMs ?? defaultTimeouts.cleanupMs;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300_000)
    throw new Error('插件清理请求预算必须为 1 至 300000 毫秒');
  return (cleanup: CleanupCallback): Dispose => {
    if (options.signal.aborted)
      throw new HostError('cancelled', 'cleanup_owner_revoked', '不能向已撤销的作用域登记资源');
    let pending: Promise<void> | null = null;
    const run = () => {
      if (pending) return pending;
      const controller = new AbortController();
      const deadline = Date.now() + timeout;
      const transport = options.transport
        ? scopedTransportAccess(options.transport, controller.signal, (dispose) => dispose) : undefined;
      const context = Object.freeze<CleanupContext>({
        signal: controller.signal, deadline,
        ...(transport ? { transport: Object.freeze({ request: transport.request }) } : {}),
      });
      pending = awaitLifecycle(() => cleanup(context), undefined, deadline, '插件已登记资源清理')
        .finally(() => { controller.abort(); });
      return pending;
    };
    const unregister = options.onDispose(() => {
      // 子作用域已主动认领的清理错误只由该子作用域报告，不能污染根或其他插件。
      if (!pending) return run();
    });
    return () => {
      const result = run();
      void unregister();
      return result;
    };
  };
}
