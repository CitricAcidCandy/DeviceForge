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
  errorCode: string | null;
}
interface Attachment {
  readonly view: MountedView;
  readonly target: HTMLElement;
}
export interface MountStatus {
  readonly state: 'idle' | 'mounting' | 'ready' | 'failed';
  readonly error: string | null;
}
/** DOM在布局槽之间移动，隐藏页仅脱离显示位置，不销毁视图自己的草稿。 */
export function createMountPool(ui: UiAccess, document: Document, signal: AbortSignal, staging?: HTMLElement) {
  const views = new Map<string, MountedView>();
  const targets = new Map<HTMLElement, Attachment>();
  const placements = new Map<MountedView, Attachment>();
  const listeners = new Set<() => void>();
  const pending = new Set<Promise<void>>();
  const cleanupErrors: string[] = [];
  const loadedEpochs = new Map<string, number>();
  let closed = false, revision = 0;
  let disposal: Promise<void> | null = null;
  const notify = () => { revision++; for (const listener of [...listeners]) listener(); };
  function detach(attachment: Attachment) {
    if (targets.get(attachment.target) !== attachment || placements.get(attachment.view) !== attachment) return;
    targets.delete(attachment.target);
    placements.delete(attachment.view);
    if (attachment.view.root.parentNode === attachment.target) attachment.view.root.remove();
  }
  function place(view: MountedView, target: HTMLElement): Attachment {
    const previous = targets.get(target), placement = placements.get(view);
    if (previous) detach(previous);
    if (placement) detach(placement);
    target.append(view.root);
    const attachment = { view, target };
    targets.set(target, attachment);
    placements.set(view, attachment);
    return attachment;
  }
  function release(view: MountedView) {
    view.controller.abort();
    const attachment = placements.get(view);
    if (attachment) detach(attachment);
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
      state: 'mounting', error: null, errorCode: null,
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
          view.errorCode = error !== null && typeof error === 'object' &&
            'code' in error && typeof error.code === 'string' ? error.code : null;
          if (!recoverEarly(view)) notify();
          throw error;
        }
      }),
    };
    views.set(instanceId, view);
    void view.promise.catch(() => undefined);
    return view;
  }
  function restart(instanceId: string): MountedView {
    const existing = views.get(instanceId);
    const attachment = existing ? placements.get(existing) : undefined;
    const parent = existing?.root.parentElement;
    if (existing) void release(existing);
    const next = obtain(instanceId);
    if (attachment) place(next, attachment.target);
    else parent?.append(next.root);
    notify();
    return next;
  }
  function recoverEarly(view: MountedView): boolean {
    // 旧宿主可能在激活完成前拒绝；只补这类未进入视图回调的明确拒绝。
    if (closed || signal.aborted || views.get(view.instanceId) !== view ||
        view.state !== 'failed' || view.errorCode !== 'workspace_provider_revoked' ||
        view.loadedEpoch >= (loadedEpochs.get(view.providerId) ?? 0)) return false;
    try { void restart(view.instanceId).promise.catch(() => undefined); }
    catch { notify(); /* 提供者再次撤销时保留模型占位。 */ }
    return true;
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
      // 位置可以先换实例再收到旧清理；只撤本池拥有的旧根，不清空业务DOM。
      const attachment = place(view, target);
      return () => { detach(attachment); };
    },
    retry(instanceId: string) {
      return restart(instanceId).promise;
    },
    providerLoaded(pluginId: string) {
      const epoch = (loadedEpochs.get(pluginId) ?? 0) + 1;
      loadedEpochs.set(pluginId, epoch);
      for (const view of [...views.values()]) {
        if (view.providerId === pluginId) recoverEarly(view);
      }
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
