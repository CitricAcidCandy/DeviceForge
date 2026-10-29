import type { Dispose, UiAccess } from '@deviceforge/plugin-sdk';

interface MountedView {
  readonly instanceId: string;
  readonly generation: number;
  readonly providerId: string;
  readonly loadedEpoch: number;
  readonly root: HTMLElement;
  readonly controller: AbortController;
  readonly promise: Promise<void>;
  release: Dispose | null;
  state: 'mounting' | 'ready' | 'failed';
  error: string | null;
}
export interface MountStatus {
  readonly state: 'idle' | 'mounting' | 'ready' | 'failed';
  readonly error: string | null;
}
/** DOM在布局槽之间移动，隐藏页仅脱离显示位置，不销毁视图自己的草稿。 */
export function createMountPool(ui: UiAccess, document: Document, signal: AbortSignal, staging?: HTMLElement) {
  const views = new Map<string, MountedView>();
  const listeners = new Set<() => void>();
  const pending = new Set<Promise<void>>();
  const cleanupErrors: string[] = [];
  const loadedEpochs = new Map<string, number>();
  let closed = false, revision = 0;
  let disposal: Promise<void> | null = null;
  const notify = () => { revision++; for (const listener of [...listeners]) listener(); };
  function release(view: MountedView) {
    view.controller.abort();
    view.root.remove();
    if (views.get(view.instanceId) === view) views.delete(view.instanceId);
    const dispose = view.release;
    view.release = null;
    if (!dispose) return Promise.resolve();
    const task = Promise.resolve().then(dispose).catch(() => {
      cleanupErrors.push(`视图 ${view.instanceId} 的资源回收未确认`);
      if (cleanupErrors.length > 16) cleanupErrors.shift();
      notify();
    });
    pending.add(task);
    void task.then(() => pending.delete(task));
    return task;
  }
  function obtain(instanceId: string): MountedView {
    if (closed || signal.aborted) throw new Error('外壳挂载作用域已撤销');
    const instance = ui.snapshot().instances.find((entry) => entry.instanceId === instanceId);
    if (!instance || instance.state !== 'ready') throw new Error('提供者当前不可用，布局位置已保留');
    const existing = views.get(instanceId);
    if (existing?.generation === instance.generation) return existing;
    if (existing) void release(existing);
    const mount = ui.mount;
    if (!mount) throw new Error('当前平台未提供公开工作区挂载能力');
    const root = document.createElement('div');
    root.className = 'h-full min-h-0 w-full min-w-0';
    root.dataset.shellView = instanceId;
    staging?.append(root);
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const view: MountedView = {
      instanceId, generation: instance.generation, root, controller, release: null,
      providerId: instance.provider?.pluginId ?? '', loadedEpoch: loadedEpochs.get(instance.provider?.pluginId ?? '') ?? 0,
      state: 'mounting', error: null,
      promise: Promise.resolve().then(async () => {
        try {
          const dispose = await mount(instanceId, root, combined);
          if (combined.aborted || views.get(instanceId) !== view) {
            await dispose();
            return;
          }
          view.release = dispose;
          view.state = 'ready';
          notify();
        } catch (error) {
          if (combined.aborted || views.get(instanceId) !== view) throw new Error('视图准备已撤销');
          view.state = 'failed';
          view.error = error instanceof Error ? error.message : '视图挂载失败';
          notify();
          throw error;
        }
      }),
    };
    views.set(instanceId, view);
    void view.promise.catch(() => undefined);
    return view;
  }
  const unsubscribe = ui.subscribe(() => {
    if (closed) return;
    const instances = ui.snapshot().instances;
    for (const view of [...views.values()]) {
      const instance = instances.find((entry) => entry.instanceId === view.instanceId);
      if (!instance || instance.generation !== view.generation || instance.state !== 'ready') void release(view);
    }
    notify();
  });
  const dispose = () => {
    if (disposal) return disposal;
    closed = true;
    signal.removeEventListener('abort', aborted);
    unsubscribe();
    for (const view of [...views.values()]) void release(view);
    disposal = Promise.all([...pending]).then(() => { listeners.clear(); });
    return disposal;
  };
  function aborted() { void dispose(); }
  if (signal.aborted) void dispose();
  else signal.addEventListener('abort', aborted, { once: true });
  return {
    prepare(instanceId: string) { return obtain(instanceId).promise; },
    attach(instanceId: string, target: HTMLElement): Dispose {
      const view = obtain(instanceId);
      target.append(view.root);
      return () => { if (view.root.parentNode === target) view.root.remove(); };
    },
    retry(instanceId: string) {
      const existing = views.get(instanceId);
      const parent = existing?.root.parentElement;
      if (existing) void release(existing);
      const next = obtain(instanceId);
      parent?.append(next.root);
      notify();
      return next.promise;
    },
    providerLoaded(pluginId: string) {
      const epoch = (loadedEpochs.get(pluginId) ?? 0) + 1;
      loadedEpochs.set(pluginId, epoch);
      for (const view of [...views.values()]) {
        if (view.providerId !== pluginId || view.state === 'ready' || view.loadedEpoch >= epoch) continue;
        const parent = view.root.parentElement;
        void release(view);
        try {
          const next = obtain(view.instanceId);
          parent?.append(next.root);
          void next.promise.catch(() => undefined);
        } catch { /* 提供者再次撤销时保留模型占位。 */ }
      }
      notify();
    },
    drop(instanceId: string) {
      const existing = views.get(instanceId);
      return existing ? release(existing) : Promise.resolve();
    },
    status(instanceId: string): MountStatus {
      const view = views.get(instanceId);
      return { state: view?.state ?? 'idle', error: view?.error ?? null };
    },
    revision: () => revision,
    subscribe(listener: () => void): Dispose { listeners.add(listener); return () => { listeners.delete(listener); }; },
    cleanupSnapshot: (): readonly string[] => [...cleanupErrors],
    dispose,
  };
}
export type MountPool = ReturnType<typeof createMountPool>;
