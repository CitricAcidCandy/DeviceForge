import type { Dispose } from '../../plugin-sdk/models.ts';
import { JobFailure, JobWaitFailure, readHostError } from '../../plugin-sdk/index.ts';

export interface RecoveryFailure {
  readonly message: string;
  readonly logId: string | null;
}

/** 日志 ID 只来自本次失败对象；本地错误不借用历史请求的标识。 */
export function recoveryFailure(value: unknown, fallback: string): RecoveryFailure {
  const fields = readHostError(value);
  if (fields) return { message: fields.message || fallback, logId: fields.logId?.trim() ? fields.logId : null };
  try {
    if (value instanceof JobFailure || value instanceof JobWaitFailure)
      return { message: value.message || fallback, logId: value.logId?.trim() ? value.logId : null };
    return { message: value instanceof Error && value.message ? value.message : fallback, logId: null };
  }
  catch { return { message: fallback, logId: null }; }
}

/** 恢复面板独立于可替换外壳；展开和收起不卸载业务视图。 */
export function createRecoveryState() {
  const listeners = new Set<() => void>();
  let state: Readonly<{ open: boolean }> = Object.freeze({ open: false });
  let disposed = false;
  function set(open: boolean) {
    if (disposed || state.open === open) return;
    state = Object.freeze({ open });
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* 恢复入口的单个订阅不影响其他观察者。 */ }
    }
  }
  return {
    snapshot: () => state,
    subscribe(listener: () => void): Dispose {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    open: () => set(true),
    close: () => set(false),
    dispose() { disposed = true; listeners.clear(); },
  };
}
export type RecoveryState = ReturnType<typeof createRecoveryState>;
