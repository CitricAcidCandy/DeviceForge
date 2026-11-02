import { HostError } from '../../plugin-sdk/models.ts';
import type { Dispose, HostContext, LocalPointContribution, WorkspaceViewRef } from '../../plugin-sdk/index.ts';
import { recoveryFailure } from './recovery-state.ts';

export const SHELL_POINT = Object.freeze({ id: 'host.shell', version: '1' });
export interface ShellHostSnapshot {
  readonly state: 'empty' | 'preparing' | 'ready' | 'failed' | 'disposed';
  readonly active: { readonly id: string; readonly pluginId: string; readonly viewId: string } | null;
  readonly requested: string | null;
  readonly error: string | null;
  readonly errorLogId: string | null;
  readonly cleanupErrors: readonly string[];
}
export interface ShellHostOptions {
  readonly context: HostContext;
  readonly target: HTMLElement;
  readonly providerReady?: (pluginId: string, generation: number) => boolean;
}
interface Binding {
  readonly identity: string;
  readonly contribution: LocalPointContribution;
  readonly ref: WorkspaceViewRef;
  readonly instanceId: string;
  readonly root: HTMLElement;
  readonly cancellation: AbortController;
  release: Dispose | null;
  instanceGeneration: number | null;
}
function viewRef(value: LocalPointContribution | null): WorkspaceViewRef | null {
  const data = value?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      !('pluginId' in data) || typeof data.pluginId !== 'string' ||
      !('viewId' in data) || typeof data.viewId !== 'string') return null;
  return { pluginId: data.pluginId, viewId: data.viewId };
}
const identity = (value: LocalPointContribution): string =>
  `${value.provider.pluginId}:${value.provider.generation}:${value.id}`;

/** 外壳先在不可交互区准备；成功才交接，失败不能拆除仍可使用的旧外壳。 */
export function createShellHost(options: ShellHostOptions) {
  const { context, target } = options;
  const capabilities = { ui: context.ui, points: context.extensions?.points, mount: context.ui?.mount };
  if (!capabilities.ui || !capabilities.points || !capabilities.mount) throw new Error('平台缺少公开外壳组合能力');
  const ui = capabilities.ui, points = capabilities.points, mount = capabilities.mount;
  const listeners = new Set<() => void>();
  const pending = new Set<Promise<void>>();
  const cleanupErrors: string[] = [];
  let current: Binding | null = null, preparing: Binding | null = null;
  let closed = false, sequence = 0, lastAttempt = '';
  let disposal: Promise<void> | null = null;
  let state: ShellHostSnapshot = Object.freeze({
    state: 'empty', active: null, requested: null, error: null, errorLogId: null, cleanupErrors: [],
  });
  function publish(next: Omit<ShellHostSnapshot, 'cleanupErrors'>) {
    if (closed && next.state !== 'disposed') return;
    state = Object.freeze({ ...next, cleanupErrors: Object.freeze([...cleanupErrors]) });
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* 单个恢复界面不阻断外壳状态发布。 */ }
    }
  }
  const activeInfo = () => current ? {
    id: current.contribution.id, pluginId: current.ref.pluginId, viewId: current.ref.viewId,
  } : null;
  function release(binding: Binding): Promise<void> {
    binding.cancellation.abort();
    binding.root.remove();
    if (!context.signal.aborted) {
      try { ui?.close(binding.instanceId); }
      catch { /* 实例已被提供者或宿主撤销时仍需回收本次释放句柄。 */ }
    }
    const dispose = binding.release;
    binding.release = null;
    const task = Promise.resolve().then(() => dispose?.()).catch((error: unknown) => {
      cleanupErrors.push(error instanceof Error ? error.message : '外壳资源回收未确认');
      if (cleanupErrors.length > 16) cleanupErrors.shift();
      if (!closed) publish({ ...state });
    });
    pending.add(task);
    void task.then(() => pending.delete(task));
    return task;
  }
  function alive(binding: Binding) {
    const entry = points?.list(SHELL_POINT).find((item) => item.id === binding.contribution.id &&
      identity(item) === binding.identity && item.state === 'active');
    const instance = ui?.snapshot().instances.find((item) => item.instanceId === binding.instanceId);
    return !!entry && !binding.cancellation.signal.aborted && (!binding.instanceGeneration ||
      instance?.generation === binding.instanceGeneration && instance.state === 'ready');
  }
  function refresh(force = false) {
    if (closed || context.signal.aborted) return;
    if (current && !alive(current)) {
      const old = current;
      current = null;
      lastAttempt = '';
      void release(old);
    }
    const requested = points?.selected(SHELL_POINT) ?? null;
    const ref = viewRef(requested);
    if (!requested || !ref) {
      lastAttempt = '';
      // 暂不可用不是用户清空选择；注册器保留原意图，只有同一贡献恢复时才重新匹配。
      if (preparing) { const old = preparing; preparing = null; void release(old); }
      if (current) { const old = current; current = null; void release(old); }
      publish({ state: 'empty', active: null, requested: null, error: null, errorLogId: null });
      return;
    }
    const key = identity(requested);
    if (current?.identity === key) {
      publish({ state: 'ready', active: activeInfo(), requested: requested.id, error: null, errorLogId: null });
      return;
    }
    if (preparing?.identity === key || (!force && lastAttempt === key)) return;
    if (preparing) { const old = preparing; preparing = null; void release(old); }
    if (options.providerReady && !options.providerReady(requested.provider.pluginId, requested.provider.generation)) {
      publish({ state: 'preparing', active: activeInfo(), requested: requested.id, error: null, errorLogId: null });
      return;
    }
    lastAttempt = key;
    const root = target.ownerDocument.createElement('div');
    root.className = 'pointer-events-none absolute inset-0 -z-10 h-full min-h-0 w-full overflow-hidden opacity-0';
    root.setAttribute('aria-hidden', 'true');
    root.inert = true;
    target.append(root);
    const binding: Binding = {
      identity: key, contribution: requested, ref,
      instanceId: `host.shell.preview.${++sequence}`, root,
      cancellation: new AbortController(), release: null,
      instanceGeneration: null,
    };
    preparing = binding;
    publish({ state: 'preparing', active: activeInfo(), requested: requested.id, error: null, errorLogId: null });
    const signal = AbortSignal.any([context.signal, binding.cancellation.signal]);
    const task = Promise.resolve().then(async () => {
      const instance = ui.open({ instanceId: binding.instanceId, workspaceId: 'host.shell', provider: ref, visible: false }, signal);
      binding.instanceGeneration = instance.generation;
      const dispose = await mount(binding.instanceId, root, signal);
      binding.release = dispose;
      if (closed || signal.aborted || preparing !== binding || !alive(binding) ||
          points.selected(SHELL_POINT)?.id !== requested.id)
        throw new HostError('cancelled', 'shell_selection_revoked', '外壳选择已变化');
      const previous = current;
      current = binding;
      preparing = null;
      root.className = 'h-full min-h-0 w-full';
      root.removeAttribute('aria-hidden');
      root.inert = false;
      ui.setVisible(binding.instanceId, true);
      if (previous) void release(previous);
      publish({ state: 'ready', active: activeInfo(), requested: requested.id, error: null, errorLogId: null });
    }).catch(async (error: unknown) => {
      const belongs = preparing === binding;
      if (belongs) preparing = null;
      await release(binding);
      if (!belongs || closed || context.signal.aborted) return;
      const failure = recoveryFailure(error, '所选外壳未能显示，已保留可用内容');
      publish({
        state: 'failed', active: activeInfo(), requested: requested.id,
        error: failure.message, errorLogId: failure.logId,
      });
    });
    pending.add(task);
    void task.then(() => pending.delete(task));
  }
  const unsubscribe = points.subscribe(() => refresh());
  const views = ui.subscribe(() => refresh());
  const lifecycle = context.extensions?.subscribeEvent('host.plugins.changed', ({ data }) => {
    if (closed || context.signal.aborted || !data || typeof data !== 'object' ||
        Array.isArray(data) || data.stage !== 'loaded') return;
    const requested = points.selected(SHELL_POINT);
    if (!requested || data.pluginId !== requested.provider.pluginId ||
        data.generation !== requested.provider.generation) return;
    // 就绪通知只结束当前提供者的等待；已经失败的挂载仍需显式重试。
    refresh();
  });
  const aborted = () => { void dispose(); };
  function dispose(): Promise<void> {
    if (disposal) return disposal;
    closed = true;
    context.signal.removeEventListener('abort', aborted);
    void unsubscribe();
    void views();
    void lifecycle?.();
    if (preparing) { const old = preparing; preparing = null; void release(old); }
    if (current) { const old = current; current = null; void release(old); }
    disposal = Promise.allSettled([...pending]).then(() => {
      publish({ state: 'disposed', active: null, requested: null, error: null, errorLogId: null });
      listeners.clear();
    });
    return disposal;
  }
  if (context.signal.aborted) void dispose();
  else { context.signal.addEventListener('abort', aborted, { once: true }); refresh(); }
  return {
    snapshot: () => state,
    subscribe(listener: () => void): Dispose { listeners.add(listener); return () => { listeners.delete(listener); }; },
    retry: () => refresh(true),
    dispose,
  };
}
export type ShellHost = ReturnType<typeof createShellHost>;
