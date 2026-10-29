import { HostError } from '../../plugin-sdk/models.ts';
import type { JsonValue } from '../../plugin-sdk/models.ts';
import type { WorkspaceInstance, WorkspaceInstanceInput, WorkspaceViewContext, WorkspaceViewDefinition, WorkspaceViewRef } from '../../plugin-sdk/workspace.ts';
import { clone, frozen, invalid, requireId, requireJson, requireOwnedId, requireRef, sameJson } from './rules.ts';

export interface WorkspaceOwner {
  readonly pluginId: string;
  readonly generation: number;
  readonly signal: AbortSignal;
}
export interface OwnedWorkspace<T> {
  readonly owner: WorkspaceOwner;
  readonly definition: T;
}
interface InstanceEntry {
  value: WorkspaceInstance;
  owner: WorkspaceOwner | null;
  observed: OwnedWorkspace<WorkspaceViewDefinition> | null;
  controller: AbortController;
  releaseOwner: () => void;
  readonly visibility: Set<(visible: boolean) => void>;
}

export function createInstanceStore(
  provider: (ref: WorkspaceViewRef) => OwnedWorkspace<WorkspaceViewDefinition> | null,
  changed: () => void,
) {
  const entries = new Map<string, InstanceEntry>();
  let generation = 0;
  const find = (id: string) => {
    requireId(id);
    const entry = entries.get(id);
    if (!entry) invalid('视图实例不存在');
    return entry;
  };
  function rotate(entry: InstanceEntry) {
    entry.controller.abort();
    entry.visibility.clear();
    entry.controller = new AbortController();
    entry.value = frozen({ ...entry.value, generation: ++generation });
  }
  function reconcileEntry(entry: InstanceEntry, force = false) {
    const selected = entry.value.provider;
    const provided = selected ? provider(selected) : null;
    const reason = !entry.owner || entry.owner.signal.aborted ? 'owner_inactive'
      : !selected ? 'provider_unselected' : !provided ? 'provider_missing' : null;
    const state = reason === 'provider_unselected' ? 'unselected' : reason ? 'missing' : 'ready';
    const updated = force || entry.observed !== provided || entry.value.reason !== reason;
    if (!updated) return false;
    entry.observed = provided;
    rotate(entry);
    entry.value = frozen({ ...entry.value, providerGeneration: provided?.owner.generation ?? null, reason, state });
    return true;
  }
  function reconcile() {
    let updated = false;
    for (const entry of entries.values()) updated = reconcileEntry(entry) || updated;
    return updated;
  }
  function open(input: WorkspaceInstanceInput, owner: WorkspaceOwner | null, pluginId = owner?.pluginId) {
    if (!pluginId) invalid('视图实例没有归属插件');
    requireOwnedId(pluginId, input.instanceId);
    requireId(input.workspaceId);
    if (input.provider !== null) requireRef(input.provider);
    if (input.target !== undefined) requireJson(input.target);
    if (input.visible !== undefined && typeof input.visible !== 'boolean') invalid('视图可见性必须是布尔值');
    const previous = entries.get(input.instanceId);
    if (previous?.owner && !previous.owner.signal.aborted) invalid('视图实例标识已经在使用');
    if (!previous && entries.size >= 256) invalid('视图实例数量超过限制');
    const selectedProvider = input.provider ? clone(input.provider) : null;
    const selectedTarget = clone(input.target !== undefined ? input.target : previous?.value.target ?? null);
    previous?.releaseOwner();
    previous?.controller.abort();
    previous?.visibility.clear();
    const entry: InstanceEntry = {
      owner, observed: null, controller: new AbortController(), visibility: new Set(), releaseOwner: () => {},
      value: frozen({
        instanceId: input.instanceId, pluginId, workspaceId: input.workspaceId,
        provider: selectedProvider, target: selectedTarget,
        visible: input.visible ?? previous?.value.visible ?? true,
        generation: ++generation, providerGeneration: null, state: 'missing', reason: 'owner_inactive',
      }),
    };
    entries.set(input.instanceId, entry);
    if (owner) {
      const stop = () => {
        if (entries.get(input.instanceId) !== entry) return;
        if (reconcileEntry(entry, true)) changed();
      };
      owner.signal.addEventListener('abort', stop, { once: true });
      entry.releaseOwner = () => owner.signal.removeEventListener('abort', stop);
    }
    reconcileEntry(entry, true);
    changed();
    return entry.value;
  }
  function close(instanceId: string) {
    const entry = entries.get(instanceId);
    if (!entry) return;
    entries.delete(instanceId);
    entry.releaseOwner();
    entry.controller.abort();
    entry.visibility.clear();
  }
  function setTarget(instanceId: string, target: JsonValue) {
    requireJson(target);
    const entry = find(instanceId);
    if (!sameJson(entry.value.target, target)) {
      entry.value = frozen({ ...entry.value, target: clone(target) });
      reconcileEntry(entry, true);
      changed();
    }
    return entry.value;
  }
  function setVisible(instanceId: string, visible: boolean) {
    if (typeof visible !== 'boolean') invalid('视图可见性必须是布尔值');
    const entry = find(instanceId);
    if (entry.value.visible !== visible) {
      entry.value = frozen({ ...entry.value, visible });
      for (const listener of [...entry.visibility]) {
        try { listener(visible); } catch { /* 单个视图通知不能阻止其余实例更新。 */ }
      }
      changed();
    }
    return entry.value;
  }
  function selectProvider(instanceId: string, ref: WorkspaceViewRef | null) {
    if (ref !== null) requireRef(ref);
    const entry = find(instanceId);
    if (entry.value.provider?.pluginId === ref?.pluginId && entry.value.provider?.viewId === ref?.viewId) return entry.value;
    entry.value = frozen({ ...entry.value, provider: ref ? clone(ref) : null });
    reconcileEntry(entry, true);
    changed();
    return entry.value;
  }
  function resolve(instanceId: string) {
    const entry = entries.get(instanceId);
    if (!entry || entry.value.state !== 'ready' || !entry.observed) return null;
    const controller = entry.controller;
    const current = () => {
      if (controller.signal.aborted || entries.get(instanceId) !== entry || entry.controller !== controller)
        throw new HostError('cancelled', 'workspace_instance_revoked', '视图运行实例已撤销');
    };
    const context = Object.freeze<WorkspaceViewContext>({
      signal: controller.signal,
      snapshot: () => { current(); return entry.value; },
      subscribeVisibility(listener) {
        current();
        entry.visibility.add(listener);
        return () => { entry.visibility.delete(listener); };
      },
    });
    return { definition: entry.observed.definition, owner: entry.observed.owner, instance: context };
  }
  function clear() {
    for (const id of [...entries.keys()]) close(id);
  }
  return {
    open, close, setTarget, setVisible, selectProvider, reconcile, resolve, clear,
    values: () => [...entries.values()].map((entry) => entry.value),
    save: () => [...entries.values()].map(({ value }) => ({
      instanceId: value.instanceId, pluginId: value.pluginId, workspaceId: value.workspaceId,
      provider: value.provider, target: value.target, visible: value.visible,
    })),
  };
}
