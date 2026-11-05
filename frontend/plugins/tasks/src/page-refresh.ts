import type { Dispose, WorkspaceViewContext } from '@deviceforge/plugin-sdk';

interface TaskPageRefreshOptions {
  readonly element: HTMLElement;
  readonly signal: AbortSignal;
  readonly instance?: WorkspaceViewContext;
  canRefresh(): boolean;
  refresh(): void;
}

/** 只调度页面已有的只读刷新；隐藏不取消手动业务，也不清除页面草稿或错误。 */
export function startTaskPageRefresh({ element, signal, instance, canRefresh, refresh }: TaskPageRefreshOptions): () => void {
  const document = element.ownerDocument, browser = document.defaultView;
  if (!browser) return () => {};
  const timers = browser;
  const signals = new Set(instance ? [signal, instance.signal] : [signal]);
  let stopped = false, initialized = false, visible = true;
  let timer: number | null = null, period = 0;
  let unsubscribe: Dispose | undefined;
  const closed = () => stopped || [...signals].some((current) => current.aborted);
  const readVisibility = () => !instance || !instance.signal.aborted && instance.snapshot().visible;
  function clearTimer() {
    period++;
    if (timer !== null) timers.clearInterval(timer);
    timer = null;
  }
  function releaseVisibility() {
    const release = unsubscribe;
    unsubscribe = undefined;
    if (release) void Promise.resolve().then(release).catch(() => undefined);
  }
  function dispose() {
    if (stopped) return;
    stopped = true;
    clearTimer();
    document.removeEventListener('visibilitychange', synchronize);
    for (const current of signals) current.removeEventListener('abort', dispose);
    releaseVisibility();
  }
  function read() {
    if (!closed() && visible && element.isConnected && document.visibilityState === 'visible' &&
      !element.closest('[hidden]') && canRefresh()) refresh();
  }
  function synchronize() {
    if (!initialized) return;
    if (closed()) { dispose(); return; }
    if (!visible || document.visibilityState !== 'visible') { clearTimer(); return; }
    if (timer !== null) return;
    const currentPeriod = ++period;
    timer = timers.setInterval(() => {
      // 已撤销的旧定时回调不能在新的可见周期继续读取。
      if (currentPeriod === period) read();
    }, 10_000);
    read();
  }
  function visibilityChanged() {
    if (closed()) return;
    try { visible = readVisibility(); synchronize(); }
    catch (error) { dispose(); throw error; }
  }
  if (closed()) return dispose;
  try {
    document.addEventListener('visibilitychange', synchronize);
    for (const current of signals) current.addEventListener('abort', dispose, { once: true });
    if (instance) unsubscribe = instance.subscribeVisibility(visibilityChanged);
    if (closed()) { releaseVisibility(); return dispose; }
    // 订阅后校准快照，避免首次渲染与监听登记之间的可见性变化漏通知。
    visible = readVisibility();
    initialized = true;
    synchronize();
  } catch (error) { dispose(); throw error; }
  return dispose;
}
