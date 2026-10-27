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
import { awaitLifecycle, lifecycleTimeouts } from '../lifecycle.ts';
import type { LifecycleTimeouts } from '../lifecycle.ts';

const slotIdPattern = /^[a-z][a-z0-9._-]{0,199}$/;
const allModes: readonly SlotMode[] = ['append', 'replace'];

interface SlotRuntime {
  readonly definition: SlotDefinition;
  readonly modes: readonly SlotMode[];
  readonly leases: Map<SlotLease, () => Promise<void>>;
  defaultRoot: HTMLElement | null;
  defaultDispose: Dispose | null;
  replacement: SlotLease | null;
  // 释放后的槽位立刻停止重建默认渲染，避免连累后续清理。
  released: boolean;
  readonly lifetime: AbortController;
}

export async function createNamedSlotAdapter(
  definitions: readonly SlotDefinition[],
  budgets: Partial<LifecycleTimeouts> = {},
): Promise<SlotAdapter & SlotHost & { dispose: () => Promise<void>; cleanupSnapshot: () => readonly { id: string; error: unknown }[] }> {
  const timeouts = lifecycleTimeouts(budgets);
  const slots = new Map<string, SlotRuntime>();
  const lateFailures = new Map<string, unknown>();
  let closed = false;
  let disposal: Promise<void> | null = null;
  const queues = new Map<string, Promise<unknown>>();
  function serial<T>(id: string, run: () => Promise<T>): Promise<T> {
    const queue = queues.get(id) ?? Promise.resolve();
    const pending = queue.then(run, run);
    const tail = pending.then(() => undefined, () => undefined);
    queues.set(id, tail);
    void tail.then(() => {
      if (queues.get(id) === tail) queues.delete(id);
    });
    return pending;
  }
  async function clearDefault(slot: SlotRuntime) {
    const cleanup = slot.defaultDispose;
    slot.defaultDispose = null;
    slot.defaultRoot?.remove();
    slot.defaultRoot = null;
    if (cleanup) await awaitLifecycle(cleanup, undefined, Date.now() + timeouts.cleanupMs, '默认槽位清理');
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
      const render = slot.definition.renderDefault;
      const release = await awaitLifecycle(() => render(root), slot.lifetime.signal,
        Date.now() + timeouts.mountMs, '默认槽位渲染', async (late) => {
          if (typeof late === 'function') try {
            await awaitLifecycle(late, undefined, Date.now() + timeouts.cleanupMs, '迟到默认槽位清理');
          } catch (error) {
            lateFailures.set(slot.definition.id, error);
            if (lateFailures.size > 256) {
              const oldest = lateFailures.keys().next().value;
              if (oldest !== undefined) lateFailures.delete(oldest);
            }
          }
        });
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
      leases: new Map(),
      defaultRoot: null,
      defaultDispose: null,
      replacement: null,
      released: false,
      lifetime: new AbortController(),
    };
    slots.set(definition.id, slot);
    return slot;
  }
  async function releaseNow(slot: SlotRuntime) {
    // 队列内直接调用内部清理；不能等待会再次排入同一队列的 lease.dispose。
    if (slots.get(slot.definition.id) === slot) slots.delete(slot.definition.id);
    slot.released = true;
    slot.lifetime.abort();
    const failures: unknown[] = [];
    for (const releaseLease of [...slot.leases.values()]) {
      try {
        await releaseLease();
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
    let leaseDisposal: Promise<void> | null = null;
    let released = false;
    const stop = () => root.remove();
    const detach = () => {
      stop();
      signal.removeEventListener('abort', stop);
    };
    const releaseLeaseNow = async (): Promise<void> => {
      if (released) return;
      released = true;
      detach();
      slot.leases.delete(lease);
      if (slot.replacement === lease) {
        slot.replacement = null;
        await renderDefault(slot);
      }
    };
    const lease: SlotLease = {
      target: root,
      dispose() {
        if (leaseDisposal) return leaseDisposal;
        detach();
        leaseDisposal = serial(slot.definition.id, releaseLeaseNow);
        return leaseDisposal;
      },
    };
    slot.leases.set(lease, releaseLeaseNow);
    if (request.mode === 'replace') slot.replacement = lease;
    slot.definition.target.append(root);
    signal.addEventListener('abort', stop, { once: true });
    return lease;
  }
  return {
    cleanupSnapshot: () => [...lateFailures].map(([id, error]) => ({ id, error })),
    acquire: (request, signal) => serial(request.slot, () => acquireNow(request, signal)),
    // 晚注册：React 拿到真实节点后才知道挂载点，因此默认渲染不参与首帧。
    define: (definition) =>
      serial(definition.id, async () => {
        if (closed) throw new Error('宿主槽位适配器已关闭');
        const slot = add(definition);
        try {
          await renderDefault(slot);
        } catch (error) {
          try {
            await releaseNow(slot);
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], '宿主槽位定义失败且回滚不完整');
          }
          throw error;
        }
        let release: Promise<void> | null = null;
        // 闭包绑定本次实例，旧释放函数不能按名字删除后来登记的新实例。
        return () => (release ??= serial(definition.id, () => releaseNow(slot)));
      }),
    dispose() {
      if (disposal) return disposal;
      closed = true;
      for (const slot of slots.values()) {
        for (const lease of slot.leases.keys()) lease.target.remove();
        slot.released = true;
        slot.lifetime.abort();
      }
      const pending = [...slots.values()].reverse().map((slot) =>
        serial(slot.definition.id, () => releaseNow(slot)),
      );
      // 排队中尚未登记的定义也必须结束，不能在关闭后留下未消费的工作。
      const tails = [...queues.values()];
      disposal = (async () => {
        const results = await Promise.allSettled(pending);
        await Promise.all(tails);
        const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
        if (failures.length) throw new AggregateError(failures, '宿主槽位释放失败');
      })();
      return disposal;
    },
  };
}
