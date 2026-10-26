import { HostError } from '../../plugin-sdk/index.ts';
import type {
  Dispose,
  SlotAdapter,
  SlotDefinition,
  SlotHost,
  SlotLease,
  SlotMode,
  SlotRequest,
} from '../../plugin-sdk/index.ts';

const slotIdPattern = /^[a-z][a-z0-9._-]{0,199}$/;
const allModes: readonly SlotMode[] = ['append', 'replace'];

interface SlotRuntime {
  readonly definition: SlotDefinition;
  readonly modes: readonly SlotMode[];
  readonly leases: Set<SlotLease>;
  defaultRoot: HTMLElement | null;
  defaultDispose: Dispose | null;
  replacement: SlotLease | null;
  // 释放后的槽位立刻停止重建默认渲染，避免连累后续清理。
  released: boolean;
}

export async function createNamedSlotAdapter(
  definitions: readonly SlotDefinition[],
): Promise<SlotAdapter & SlotHost & { dispose: () => Promise<void> }> {
  const slots = new Map<string, SlotRuntime>();
  let closed = false;
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(run: () => Promise<T>): Promise<T> {
    const pending = queue.then(run, run);
    queue = pending.catch(() => undefined);
    return pending;
  }
  async function clearDefault(slot: SlotRuntime) {
    const cleanup = slot.defaultDispose;
    slot.defaultDispose = null;
    slot.defaultRoot?.remove();
    slot.defaultRoot = null;
    await cleanup?.();
  }
  async function renderDefault(slot: SlotRuntime) {
    if (closed || slot.released || slot.replacement || slot.defaultRoot) return;
    // 没有默认渲染器的槽位是纯挂载点：宿主自己渲染回落内容，不占用槽内 DOM。
    if (!slot.definition.renderDefault) return;
    const root = slot.definition.target.ownerDocument.createElement('div');
    root.dataset.deviceforgeDefaultSlot = slot.definition.id;
    slot.defaultRoot = root;
    slot.definition.target.append(root);
    try {
      const release = await slot.definition.renderDefault(root);
      if (typeof release !== 'function') throw new Error('默认槽位渲染必须返回释放函数');
      slot.defaultDispose = release;
    } catch (error) {
      root.remove();
      slot.defaultRoot = null;
      throw error;
    }
  }
  function inspect(definition: SlotDefinition): readonly SlotMode[] {
    if (!slotIdPattern.test(definition.id) || slots.has(definition.id))
      throw new Error('宿主槽位无效或重复');
    if (!definition.target) throw new Error('宿主槽位缺少挂载目标');
    if (definition.renderDefault !== undefined && typeof definition.renderDefault !== 'function')
      throw new Error('宿主槽位默认渲染必须是函数');
    const modes = definition.modes ?? allModes;
    if (!modes.length || modes.some((mode) => !allModes.includes(mode)))
      throw new Error('宿主槽位渲染模式声明无效');
    return modes;
  }
  function add(definition: SlotDefinition): SlotRuntime {
    const modes = inspect(definition);
    const slot: SlotRuntime = {
      definition,
      modes,
      leases: new Set(),
      defaultRoot: null,
      defaultDispose: null,
      replacement: null,
      released: false,
    };
    slots.set(definition.id, slot);
    return slot;
  }
  async function releaseNow(id: string) {
    const slot = slots.get(id);
    if (!slot) return;
    slots.delete(id);
    slot.released = true;
    const failures: unknown[] = [];
    for (const lease of [...slot.leases]) {
      try {
        await lease.dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await clearDefault(slot);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, '宿主槽位释放失败');
  }
  try {
    for (const definition of definitions) add(definition);
  } catch (error) {
    throw new AggregateError([error], '宿主槽位登记失败');
  }
  try {
    for (const slot of slots.values()) await renderDefault(slot);
  } catch (error) {
    closed = true;
    const failures: unknown[] = [error];
    for (const slot of slots.values()) {
      try {
        await clearDefault(slot);
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }
    throw new AggregateError(failures, '宿主槽位初始化失败');
  }
  async function acquireNow(request: SlotRequest, signal: AbortSignal): Promise<SlotLease> {
    if (closed || signal.aborted)
      throw new HostError('cancelled', 'slot_closed', '槽位或组件运行代次已撤销');
    const slot = slots.get(request.slot);
    if (!slot) throw new Error('宿主未登记此具名槽位');
    if (!slot.modes.includes(request.mode))
      throw new Error(request.mode === 'replace' ? '槽位不允许替换' : '槽位不允许追加');
    if (request.mode === 'replace' && slot.replacement) throw new Error('槽位已有替换渲染贡献');
    if (request.mode === 'replace') {
      try {
        await clearDefault(slot);
      } catch (error) {
        await renderDefault(slot);
        throw error;
      }
    }
    if (closed || signal.aborted) {
      await renderDefault(slot);
      throw new HostError('cancelled', 'slot_closed', '槽位获取等待已取消');
    }
    const root = slot.definition.target.ownerDocument.createElement('div');
    root.dataset.deviceforgeSlotOwner = `${request.pluginId}:${request.generation}:${request.componentId}`;
    let disposal: Promise<void> | null = null;
    const stop = () => root.remove();
    const lease: SlotLease = {
      target: root,
      dispose() {
        if (disposal) return disposal;
        stop();
        signal.removeEventListener('abort', stop);
        disposal = serial(async () => {
          slot.leases.delete(lease);
          if (slot.replacement === lease) {
            slot.replacement = null;
            await renderDefault(slot);
          }
        });
        return disposal;
      },
    };
    slot.leases.add(lease);
    if (request.mode === 'replace') slot.replacement = lease;
    slot.definition.target.append(root);
    signal.addEventListener('abort', stop, { once: true });
    return lease;
  }
  return {
    acquire: (request, signal) => serial(() => acquireNow(request, signal)),
    // 晚注册：React 拿到真实节点后才知道挂载点，因此默认渲染不参与首帧。
    define: (definition) =>
      serial(async () => {
        if (closed) throw new Error('宿主槽位适配器已关闭');
        const slot = add(definition);
        try {
          await renderDefault(slot);
        } catch (error) {
          try {
            await releaseNow(definition.id);
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], '宿主槽位定义失败且回滚不完整');
          }
          throw error;
        }
        return () => serial(() => releaseNow(definition.id));
      }),
    async dispose() {
      closed = true;
      for (const slot of slots.values()) {
        for (const lease of slot.leases) lease.target.remove();
        slot.released = true;
      }
      const failures: unknown[] = [];
      for (const slot of [...slots.values()].reverse()) {
        for (const lease of [...slot.leases]) {
          try {
            await lease.dispose();
          } catch (error) {
            failures.push(error);
          }
        }
        try {
          await clearDefault(slot);
        } catch (error) {
          failures.push(error);
        }
      }
      slots.clear();
      if (failures.length) throw new AggregateError(failures, '宿主槽位释放失败');
    },
  };
}
