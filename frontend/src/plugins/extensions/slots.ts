import { HostError } from '../../plugin-sdk/index.ts';
import type { Dispose, SlotAdapter, SlotDefinition, SlotLease, SlotRequest } from '../../plugin-sdk/index.ts';

interface SlotRuntime {
  readonly definition: SlotDefinition;
  readonly leases: Set<SlotLease>;
  defaultRoot: HTMLElement | null;
  defaultDispose: Dispose | null;
  replacement: SlotLease | null;
}
export async function createNamedSlotAdapter(definitions: readonly SlotDefinition[]): Promise<SlotAdapter & { dispose: () => Promise<void> }> {
  const slots = new Map<string, SlotRuntime>();
  let closed = false;
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(run: () => Promise<T>): Promise<T> {
    const pending = queue.then(run, run); queue = pending.catch(() => undefined); return pending;
  }
  async function clearDefault(slot: SlotRuntime) {
    const cleanup = slot.defaultDispose;
    slot.defaultDispose = null; slot.defaultRoot?.remove(); slot.defaultRoot = null;
    await cleanup?.();
  }
  async function renderDefault(slot: SlotRuntime) {
    if (closed || slot.replacement || slot.defaultRoot) return;
    const root = slot.definition.target.ownerDocument.createElement('div');
    root.dataset.deviceforgeDefaultSlot = slot.definition.id;
    slot.defaultRoot = root; slot.definition.target.append(root);
    try {
      const release = await slot.definition.renderDefault(root);
      if (typeof release !== 'function') throw new Error('默认槽位渲染必须返回释放函数');
      slot.defaultDispose = release;
    } catch (error) { root.remove(); slot.defaultRoot = null; throw error; }
  }
  for (const definition of definitions) {
    if (!/^[a-z][a-z0-9._-]{0,199}$/.test(definition.id) || slots.has(definition.id)) throw new Error('宿主槽位无效或重复');
    slots.set(definition.id, { definition, leases: new Set(), defaultRoot: null, defaultDispose: null, replacement: null });
  }
  try { for (const slot of slots.values()) await renderDefault(slot); }
  catch (error) {
    closed = true;
    const failures: unknown[] = [error];
    for (const slot of slots.values()) { try { await clearDefault(slot); } catch (cleanupError) { failures.push(cleanupError); } }
    throw new AggregateError(failures, '宿主槽位初始化失败');
  }
  async function acquireNow(request: SlotRequest, signal: AbortSignal): Promise<SlotLease> {
    if (closed || signal.aborted) throw new HostError('cancelled', 'slot_closed', '槽位或组件运行代次已撤销');
    const slot = slots.get(request.slot);
    if (!slot) throw new Error('宿主未登记此具名槽位');
    if (request.mode === 'replace' && slot.replacement) throw new Error('槽位已有替换渲染贡献');
    if (request.mode === 'replace') {
      try { await clearDefault(slot); }
      catch (error) { await renderDefault(slot); throw error; }
    }
    if (closed || signal.aborted) { await renderDefault(slot); throw new HostError('cancelled', 'slot_closed', '槽位获取等待已取消'); }
    const root = slot.definition.target.ownerDocument.createElement('div');
    root.dataset.deviceforgeSlotOwner = `${request.pluginId}:${request.generation}:${request.componentId}`;
    let disposal: Promise<void> | null = null;
    const stop = () => root.remove();
    const lease: SlotLease = {
      target: root,
      dispose() {
        if (disposal) return disposal;
        stop(); signal.removeEventListener('abort', stop);
        disposal = serial(async () => {
          slot.leases.delete(lease);
          if (slot.replacement === lease) { slot.replacement = null; await renderDefault(slot); }
        });
        return disposal;
      },
    };
    slot.leases.add(lease); if (request.mode === 'replace') slot.replacement = lease;
    slot.definition.target.append(root); signal.addEventListener('abort', stop, { once: true });
    return lease;
  }
  return {
    acquire: (request, signal) => serial(() => acquireNow(request, signal)),
    async dispose() {
      closed = true;
      for (const slot of slots.values()) for (const lease of slot.leases) lease.target.remove();
      const failures: unknown[] = [];
      for (const slot of [...slots.values()].reverse()) {
        for (const lease of [...slot.leases]) { try { await lease.dispose(); } catch (error) { failures.push(error); } }
        try { await clearDefault(slot); } catch (error) { failures.push(error); }
      }
      slots.clear();
      if (failures.length) throw new AggregateError(failures, '宿主槽位释放失败');
    },
  };
}
