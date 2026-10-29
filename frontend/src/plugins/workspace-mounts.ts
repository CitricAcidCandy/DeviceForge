import { HostError } from '../plugin-sdk/models.ts';
import type { ComponentContribution, Dispose, HostContext, WorkspaceViewContext } from '../plugin-sdk/index.ts';
import { createExtensionMounts } from './extensions/mounts.ts';
import type { Owned } from './extensions/types.ts';
import { awaitLifecycle, createKeyedQueue, lifecycleTimeouts } from './lifecycle.ts';
import type { LifecycleTimeouts } from './lifecycle.ts';
import { createPluginScope } from './scope.ts';
import type { PluginScope } from './scope.ts';
import type { createWorkspaceRegistry } from './workspace/index.ts';

export interface WorkspaceMountDiagnostic {
  readonly instanceId: string;
  readonly pluginId: string;
  readonly generation: number;
  readonly at: number;
  readonly error: unknown;
}
export interface WorkspaceMountOptions {
  readonly registry: ReturnType<typeof createWorkspaceRegistry>;
  readonly contextFor: (pluginId: string, generation: number) => HostContext | null;
  readonly timeouts?: Partial<LifecycleTimeouts>;
}
interface Binding {
  readonly instanceId: string;
  readonly generation: number;
  readonly providerGeneration: number;
  readonly target: HTMLElement;
  readonly entry: Owned<ComponentContribution>;
  readonly scope: PluginScope;
  readonly instance: WorkspaceViewContext;
  readonly cleanupBudget: { deadline?: number };
  ready: boolean;
  cleanup: Promise<void> | null;
}

/** 工作区只适配实例身份，具体挂载、迟到释放与清理仍复用已有扩展生命周期。 */
export function createWorkspaceMounts(options: WorkspaceMountOptions) {
  const timeouts = lifecycleTimeouts(options.timeouts);
  const mounts = createExtensionMounts(timeouts);
  const serial = createKeyedQueue();
  const bindings = new Map<string, Binding>();
  const cleanups = new Set<Promise<void>>();
  const diagnostics: WorkspaceMountDiagnostic[] = [];
  const epochs = new Map<string, number>();
  const lifetime = new AbortController();
  let closed = false;
  let disposal: Promise<void> | null = null;
  function diagnostic(binding: Binding, error: unknown) {
    diagnostics.push(Object.freeze({
      instanceId: binding.instanceId, pluginId: binding.entry.owner.pluginId,
      generation: binding.generation, at: Date.now(), error,
    }));
    if (diagnostics.length > 32) diagnostics.splice(0, diagnostics.length - 32);
  }
  function cleanup(binding: Binding): Promise<void> {
    if (binding.cleanup) return binding.cleanup;
    binding.ready = false;
    if (bindings.get(binding.instanceId) === binding) bindings.delete(binding.instanceId);
    binding.cleanupBudget.deadline ??= Date.now() + timeouts.cleanupMs;
    const deadline = binding.cleanupBudget.deadline;
    const pending = Promise.resolve().then(() => awaitLifecycle(() => binding.scope.dispose(), undefined,
      deadline, '工作区视图资源回收')).catch((error: unknown) => {
        const failure = error instanceof HostError && error.code === 'plugin_lifecycle_timeout'
          ? new HostError('protocol', 'plugin_cleanup_timeout', error.message) : error;
        diagnostic(binding, failure);
        throw failure;
      });
    binding.cleanup = pending;
    cleanups.add(pending);
    void pending.then(() => cleanups.delete(pending), () => cleanups.delete(pending));
    // 先发布回收身份再同步撤资格及DOM，防止abort回调递归重复创建回收。
    binding.scope.close();
    return pending;
  }
  async function mountNow(instanceId: string, target: HTMLElement, caller: AbortSignal | undefined, epoch: number, deadline: number): Promise<Dispose> {
    if (closed || (epochs.get(instanceId) ?? 0) !== epoch || caller?.aborted)
      throw new HostError('cancelled', 'workspace_mount_revoked', '工作区挂载请求已撤销');
    const resolved = options.registry.resolveView(instanceId);
    if (!resolved) throw new HostError('protocol', 'workspace_view_unavailable', '工作区视图未选择提供者或当前不可用');
    const snapshot = resolved.instance.snapshot();
    const providerContext = options.contextFor(resolved.owner.pluginId, resolved.owner.generation);
    if (!providerContext || providerContext.signal.aborted)
      throw new HostError('cancelled', 'workspace_provider_revoked', '工作区提供者上下文已撤销');
    const previous = bindings.get(instanceId);
    if (previous && previous.generation === snapshot.generation &&
        previous.providerGeneration === resolved.owner.generation && previous.target === target && previous.ready)
      return () => cleanup(previous);
    if (previous) await cleanup(previous).catch(() => undefined);
    const signal = AbortSignal.any([
      lifetime.signal, providerContext.signal, resolved.owner.signal,
      resolved.instance.signal, ...(caller ? [caller] : []),
    ]);
    if (signal.aborted) throw new HostError('cancelled', 'workspace_mount_revoked', '工作区挂载请求已撤销');
    const scope = createPluginScope({ ...providerContext, signal });
    const id = `workspace.${instanceId}.${snapshot.generation}`;
    const contribution: ComponentContribution = {
      id, title: resolved.definition.title, slot: snapshot.workspaceId,
      mount(root, context) {
        root.dataset.deviceforgeWorkspaceInstance = instanceId;
        root.dataset.deviceforgeWorkspaceView = resolved.definition.id;
        root.dataset.deviceforgeWorkspaceGeneration = String(snapshot.generation);
        return resolved.definition.mount(root, context, resolved.instance);
      },
    };
    const entry: Owned<ComponentContribution> = {
      contribution, owner: {
        pluginId: resolved.owner.pluginId, generation: resolved.owner.generation, context: scope.context,
      },
    };
    const binding: Binding = {
      instanceId, generation: snapshot.generation, providerGeneration: resolved.owner.generation,
      target, entry, scope, instance: resolved.instance, ready: false, cleanup: null, cleanupBudget: {},
    };
    const revoked = () => { void cleanup(binding).catch(() => undefined); };
    scope.context.signal.addEventListener('abort', revoked, { once: true });
    scope.track(() => scope.context.signal.removeEventListener('abort', revoked));
    bindings.set(instanceId, binding);
    try {
      await mounts.mount(entry, target, () => bindings.get(instanceId) === binding &&
        !scope.context.signal.aborted && !resolved.instance.signal.aborted,
      undefined, signal, deadline, binding.cleanupBudget);
      if (bindings.get(instanceId) !== binding || signal.aborted)
        throw new HostError('cancelled', 'workspace_mount_revoked', '工作区挂载请求已撤销');
      binding.ready = true;
      return () => cleanup(binding);
    } catch (error) {
      try { await cleanup(binding); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], '工作区挂载失败且回收不完整'); }
      throw error;
    }
  }
  return {
    mount(instanceId: string, target: HTMLElement, signal?: AbortSignal) {
      const epoch = epochs.get(instanceId) ?? 0;
      const deadline = Date.now() + timeouts.mountMs;
      return serial(instanceId, () => mountNow(instanceId, target, signal, epoch, deadline));
    },
    unmount(instanceId: string) {
      epochs.set(instanceId, (epochs.get(instanceId) ?? 0) + 1);
      const binding = bindings.get(instanceId);
      return binding ? cleanup(binding) : Promise.resolve();
    },
    has(instanceId: string) {
      const binding = bindings.get(instanceId);
      return !!binding && binding.ready && !binding.scope.context.signal.aborted && mounts.has(binding.entry);
    },
    cleanupSnapshot: (): readonly WorkspaceMountDiagnostic[] => Object.freeze([...diagnostics]),
    dispose() {
      if (disposal) return disposal;
      closed = true;
      lifetime.abort();
      for (const binding of [...bindings.values()]) void cleanup(binding).catch(() => undefined);
      disposal = Promise.allSettled([...cleanups]).then((results) => {
        epochs.clear();
        const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
        if (failures.length) throw new AggregateError(failures, '工作区挂载桥回收不完整');
      });
      return disposal;
    },
  };
}
