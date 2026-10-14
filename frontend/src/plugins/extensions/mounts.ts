import { HostError } from '../../plugin-sdk/index.ts';
import type { ComponentContribution, Dispose, ModuleContribution } from '../../plugin-sdk/index.ts';
import { createPluginScope } from '../scope.ts';
import type { Owned } from './types.ts';
import { ensureOwner } from './invocation.ts';

export function createExtensionMounts() {
  const mounted = new Map<
    string,
    {
      entry: Owned<ComponentContribution | ModuleContribution>;
      dispose: () => Promise<void>;
      close: () => void;
    }
  >();
  async function mount(
    entry: Owned<ComponentContribution | ModuleContribution>,
    target: HTMLElement,
    available: () => boolean,
    releaseTarget?: Dispose,
  ) {
    ensureOwner(entry.owner);
    const id = entry.contribution.id;
    const existing = mounted.get(id);
    if (existing) {
      if (existing.entry === entry) return;
      await existing.dispose();
    }
    const scope = createPluginScope(entry.owner.context);
    if (releaseTarget) scope.track(releaseTarget);
    const root = target.ownerDocument.createElement('div');
    root.dataset.deviceforgeExtension = id;
    scope.track(() => root.remove());
    const abort = () => scope.close();
    scope.track(() => {
      mounted.delete(id);
    });
    entry.owner.context.signal.addEventListener('abort', abort, { once: true });
    scope.track(() => entry.owner.context.signal.removeEventListener('abort', abort));
    const dispose = () => scope.dispose();
    entry.owner.context.onDispose(dispose);
    mounted.set(id, { entry, dispose, close: scope.close });
    try {
      target.append(root);
      const release = await entry.contribution.mount(root, scope.context);
      if (typeof release !== 'function') throw new Error('组件或模块挂载必须返回释放函数');
      scope.track(release);
      ensureOwner(entry.owner);
      if (scope.context.signal.aborted || !available())
        throw new HostError('cancelled', 'mount_revoked', '扩展挂载已撤销');
    } catch (error) {
      try {
        await scope.dispose();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], '扩展挂载失败且回滚不完整');
      }
      throw error;
    }
  }
  return {
    mount,
    has: (entry: Owned<ComponentContribution | ModuleContribution>) =>
      mounted.get(entry.contribution.id)?.entry === entry,
    close: (id: string) => {
      mounted.get(id)?.close();
    },
    async unmount(id: string) {
      const entry = mounted.get(id);
      if (entry) await entry.dispose();
    },
  };
}
