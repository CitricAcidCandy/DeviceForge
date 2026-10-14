import { HostError } from '../../plugin-sdk/index.ts';

// 只撤销宿主等待；可信回调自身的副作用仍由插件负责清理。
export function awaitActive<T>(callback: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let listening = false;
    function finish(deliver: () => void) {
      if (settled) return;
      settled = true;
      if (listening) {
        signal.removeEventListener('abort', abort);
        listening = false;
      }
      deliver();
    }
    function abort() {
      finish(() => reject(new HostError('cancelled', 'extension_revoked', '扩展调用等待已撤销')));
    }
    if (signal.aborted) {
      abort();
      return;
    }
    listening = true;
    signal.addEventListener('abort', abort, { once: true });
    try {
      // 即使回调同步触发取消，也登记成功和拒绝处理，消费所有晚到结果。
      Promise.resolve(callback()).then(
        (value) => {
          if (signal.aborted) abort();
          else finish(() => resolve(value));
        },
        (error: unknown) => {
          if (signal.aborted) abort();
          else finish(() => reject(error));
        },
      );
    } catch (error) {
      if (signal.aborted) abort();
      else finish(() => reject(error));
    }
  });
}
