import type { MirroringControl } from '../../features/mirroring-streaming/index.ts';

// 输入按顺序派发；连续移动只保留最新位置，按下与释放不可互相撤销。
export function createMediaControlQueue(options: {
  readonly identity: () => string;
  readonly send: (value: MirroringControl, signal: AbortSignal) => Promise<unknown>;
  readonly failed: (error: unknown) => void;
}) {
  const lifetime = new AbortController();
  const pending: { values: readonly MirroringControl[]; identity: string }[] = [];
  let running = false;
  async function drain() {
    if (running) return;
    running = true;
    try {
      while (pending.length && !lifetime.signal.aborted) {
        const entry = pending.shift();
        if (!entry || entry.identity !== options.identity()) continue;
        try {
          for (const value of entry.values) {
            if (entry.identity !== options.identity() || lifetime.signal.aborted) break;
            await options.send(value, lifetime.signal);
          }
        } catch (error) {
          if (!lifetime.signal.aborted && entry.identity === options.identity())
            options.failed(error);
        }
      }
    } finally {
      running = false;
    }
  }
  return {
    enqueue(values: readonly MirroringControl[]) {
      if (lifetime.signal.aborted || values.length === 0) return;
      const next = { values, identity: options.identity() };
      const value = values.length === 1 ? values[0] : undefined;
      const last = pending.at(-1);
      const previous = last?.values.length === 1 ? last.values[0] : undefined;
      const repeatedKey = value?.type === 'key' && value.action === 'down' &&
        (value.repeat ?? 0) > 0 && previous?.type === 'key' && previous.action === 'down' &&
        (previous.repeat ?? 0) > 0 && previous.keycode === value.keycode &&
        previous.meta_state === value.meta_state;
      if (
        (value?.type === 'touch' &&
        value.action === 'move' &&
        previous?.type === 'touch' &&
        previous.action === 'move' &&
        previous.pointer_id === value.pointer_id || repeatedKey) &&
        last?.identity === next.identity
      )
        pending[pending.length - 1] = next;
      else {
        if (pending.length >= 256) {
          const repeated = pending.findIndex((entry) => {
            const candidate = entry.values.length === 1 ? entry.values[0] : undefined;
            return entry.identity === next.identity && candidate?.type === 'key' &&
              candidate.action === 'down' && (candidate.repeat ?? 0) > 0;
          });
          if (repeated >= 0) pending.splice(repeated, 1);
          else {
            options.failed(new Error('设备输入积压，请暂停操作并等待回执'));
            return;
          }
        }
        pending.push(next);
      }
      void drain();
    },
    clear() {
      pending.length = 0;
    },
    dispose() {
      lifetime.abort();
      pending.length = 0;
    },
  };
}
