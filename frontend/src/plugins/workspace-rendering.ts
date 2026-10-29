import { HostError } from '../plugin-sdk/models.ts';
import type { Dispose } from '../plugin-sdk/models.ts';
import type { UiAccess } from '../plugin-sdk/workspace.ts';
import { awaitLifecycle, defaultTimeouts, lifecycleTimeouts } from './lifecycle.ts';
import type { LifecycleTimeouts } from './lifecycle.ts';

export type WorkspaceRenderer = (
  instanceId: string,
  target: HTMLElement,
  signal: AbortSignal,
) => Promise<Dispose>;
export interface WorkspaceRenderingDiagnostic {
  readonly instanceId: string;
  readonly at: number;
  readonly error: unknown;
}

/** 只管理一次公开挂载的等待和释放；实际DOM与实例生命周期由既有挂载桥负责。 */
export async function mountWorkspaceResource(
  invoke: (signal: AbortSignal) => Promise<Dispose>,
  signal: AbortSignal,
  track: (dispose: Dispose) => Dispose,
  timeouts: LifecycleTimeouts = defaultTimeouts,
  onCleanupError: (error: unknown) => void = () => {},
): Promise<Dispose> {
  const cancellation = new AbortController();
  const combined = AbortSignal.any([signal, cancellation.signal]);
  const cancelled = () => new HostError('cancelled', 'workspace_mount_revoked', '工作区挂载请求已撤销');
  if (combined.aborted) throw cancelled();
  let mounted: Dispose | null = null;
  let finished = false;
  let releaseTask: void | Promise<void>;
  function bounded(release: Dispose): Dispose {
    let task: Promise<void> | null = null;
    return () => {
      task ??= awaitLifecycle(() => release(), undefined, Date.now() + timeouts.cleanupMs,
        '工作区挂载资源回收').catch((error: unknown) => {
          onCleanupError(error);
          throw error;
        });
      return task;
    };
  }
  const dispose = track(() => {
    if (finished) return releaseTask;
    finished = true;
    combined.removeEventListener('abort', revoked);
    cancellation.abort();
    releaseTask = mounted?.();
    return releaseTask;
  });
  function revoked() { void Promise.resolve(dispose()).catch(() => undefined); }
  combined.addEventListener('abort', revoked, { once: true });
  try {
    const release = await awaitLifecycle(() => invoke(combined), combined,
      Date.now() + timeouts.mountMs, '工作区公开挂载', async (late) => {
        if (typeof late === 'function') await track(bounded(late))();
      });
    if (typeof release !== 'function')
      throw new HostError('protocol', 'workspace_mount_release_invalid', '工作区挂载必须返回释放函数');
    mounted = bounded(release);
    if (finished || combined.aborted) {
      // 已撤销的旧作用域仍认领晚到资源，不能交给当前实例。
      await track(mounted)();
      throw cancelled();
    }
    return dispose;
  } catch (error) {
    try { await dispose(); }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError], '工作区公开挂载失败且回收不完整');
    }
    throw error;
  }
}

/** 模型保持纯数据，运行时可后置注入或撤销唯一渲染入口。 */
export function createWorkspaceRendering(value: Partial<LifecycleTimeouts> = {}) {
  const timeouts = lifecycleTimeouts(value);
  const active = new Set<Dispose>();
  const pending = new Set<Promise<void>>();
  const diagnostics: WorkspaceRenderingDiagnostic[] = [];
  let current: { renderer: WorkspaceRenderer; controller: AbortController } | null = null;
  let closed = false;
  let disposal: Promise<void> | null = null;
  function track(release: Dispose): Dispose {
    let released = false;
    let task: Promise<void> | undefined;
    const owned = () => {
      if (released) return task;
      released = true;
      active.delete(owned);
      try { task = Promise.resolve(release()); }
      catch (error) { task = Promise.reject(error); }
      const waiting = task;
      pending.add(waiting);
      void waiting.then(() => pending.delete(waiting), () => pending.delete(waiting));
      return waiting;
    };
    active.add(owned);
    return owned;
  }
  return {
    access(base: UiAccess): UiAccess {
      return Object.freeze({
        ...base,
        mount(instanceId: string, target: HTMLElement, signal?: AbortSignal): Promise<Dispose> {
          const selected = current;
          if (closed || !selected)
            return Promise.reject(new HostError('cancelled', 'workspace_renderer_unavailable', '工作区渲染入口当前不可用'));
          const combined = signal ? AbortSignal.any([signal, selected.controller.signal]) : selected.controller.signal;
          return mountWorkspaceResource((running) => selected.renderer(instanceId, target, running),
            combined, track, timeouts, (error) => {
              diagnostics.push(Object.freeze({ instanceId, at: Date.now(), error }));
              if (diagnostics.length > 32) diagnostics.splice(0, diagnostics.length - 32);
            });
        },
      });
    },
    setRenderer(renderer: WorkspaceRenderer | null): Dispose {
      if (closed) throw new HostError('cancelled', 'workspace_renderer_revoked', '工作区渲染适配已撤销');
      const previous = current;
      const selected = renderer ? { renderer, controller: new AbortController() } : null;
      current = selected;
      previous?.controller.abort();
      return () => {
        if (current !== selected) return;
        current = null;
        selected?.controller.abort();
      };
    },
    cleanupSnapshot: (): readonly WorkspaceRenderingDiagnostic[] => Object.freeze([...diagnostics]),
    dispose(): Promise<void> {
      if (disposal) return disposal;
      closed = true;
      current?.controller.abort();
      current = null;
      for (const release of [...active]) void Promise.resolve(release()).catch(() => undefined);
      disposal = Promise.allSettled([...pending]).then((results) => {
        const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
        if (failures.length) throw new AggregateError(failures, '工作区渲染适配回收不完整');
      });
      return disposal;
    },
  };
}
