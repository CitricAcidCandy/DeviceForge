import type { GlobalMessage, MessageController, MessageLevel, MessageOptions } from './types.ts';

// 消息属于产品实例；不使用跨实例单例，也不在构造时启动计时或网络。
export function createMessageController(): MessageController {
  let state: readonly GlobalMessage[] = Object.freeze([]);
  let sequence = 0;
  let closed = false;
  const listeners = new Set<() => void>();
  function publish(next: readonly GlobalMessage[]) {
    if (closed) return;
    state = Object.freeze(next);
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // 一个展示订阅失败不阻断其他订阅及业务调用。
      }
    }
  }
  function show(level: MessageLevel, title: string, options: MessageOptions = {}) {
    if (closed) return '';
    // 只有显式消息 ID 才更新原提示；重复操作需要新的展示和关闭计时。
    const id = options.id ?? `message-${++sequence}`;
    const message = Object.freeze({
      ...options,
      ...(options.details
        ? { details: Object.freeze(options.details.map((detail) => Object.freeze({ ...detail }))) }
        : {}),
      id,
      level,
      title,
    });
    // 重复提示换用新 ID 以重新开始展示时间，同时避免顶部堆积同一句话。
    // 优先保留正在执行的取消入口；普通消息最多同时展示三条。
    const next = [
      ...state.filter(
        (item) =>
          item.id !== id &&
          (options.id !== undefined ||
            level === 'loading' ||
            item.level !== level ||
            item.title !== title ||
            item.description !== options.description ||
            (item.logId ?? null) !== (options.logId ?? null)),
      ),
      message,
    ];
    while (next.filter((item) => item.level !== 'loading').length > 3) {
      const removable = next.findIndex((item) => item.level !== 'loading');
      next.splice(removable, 1);
    }
    publish(next);
    return id;
  }
  return {
    success: (title, options) => show('success', title, options),
    info: (title, options) => show('info', title, options),
    warning: (title, options) => show('warning', title, options),
    error: (title, options) => show('error', title, options),
    loading: (title, options) => show('loading', title, options),
    dismiss(id) {
      publish(state.filter((item) => item.id !== id));
    },
    clear() {
      publish([]);
    },
    snapshot: () => state,
    subscribe(listener) {
      if (closed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      if (closed) return;
      publish([]);
      closed = true;
      listeners.clear();
    },
  };
}
