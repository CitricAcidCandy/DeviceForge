import { awaitLifecycle, defaultTimeouts } from '../../plugins/lifecycle.ts';

/** 仅管理尚未迁出的兼容业务实例，不承担插件装卸或依赖解析。 */
export function createLazyProductResources(cleanupMs = defaultTimeouts.cleanupMs) {
  if (!Number.isSafeInteger(cleanupMs) || cleanupMs < 1 || cleanupMs > 300_000)
    throw new Error('兼容业务清理预算必须为 1 至 300000 毫秒');
  const resources = new Map<string, () => void | Promise<void>>();
  let closed = false, closing: Promise<void> | null = null;
  function current() { if (closed) throw new Error('旧业务兼容层已关闭'); }
  return {
    lazy<T>(name: string, create: () => T, release: (value: T) => void | Promise<void>): () => T {
      current();
      let value: { readonly current: T } | null = null;
      return () => {
        current();
        if (!value) {
          const instance = create();
          value = { current: instance };
          resources.set(name, () => release(instance));
        }
        return value.current;
      };
    },
    snapshot: () => [...resources.keys()],
    dispose(): Promise<void> {
      if (closing) return closing;
      closed = true;
      const deadline = Date.now() + cleanupMs;
      const tasks: Promise<void>[] = [];
      for (const [name, release] of resources) {
        try {
          // 终端等释放请求须先发起，再由外层撤销运行时；不会创建未使用的业务。
          const pending = Promise.resolve(release());
          void pending.catch(() => undefined);
          tasks.push(awaitLifecycle(() => pending, undefined, deadline, `兼容业务 ${name} 清理`));
        } catch (error) { tasks.push(Promise.reject(error)); }
      }
      closing = Promise.allSettled(tasks).then((results) => {
        const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
        if (failures.length) throw new AggregateError(failures, '旧业务兼容资源清理未确认');
      });
      return closing;
    },
  };
}
