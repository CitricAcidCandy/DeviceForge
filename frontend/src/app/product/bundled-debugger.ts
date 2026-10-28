import type { createFrontendRuntime } from '../runtime.ts';
import { isLoopbackDebuggerAddress } from '../../features/debugger/index.ts';

export const BUNDLED_DEBUGGER_ID = 'deviceforge_debugger';
export const BUNDLED_DEBUGGER_VERSION = '0.1.0';
export interface BundledDebuggerSnapshot {
  readonly phase: 'idle' | 'loading' | 'loaded' | 'disabled' | 'external' | 'unavailable' | 'failed';
  readonly message: string | null;
}
export interface BundledDebuggerOptions {
  readonly runtime: ReturnType<typeof createFrontendRuntime>;
  readonly baseUrl: string;
  readonly browserOrigin: string;
  readonly load: (signal: AbortSignal) => Promise<unknown>;
  readonly persistence?: Pick<Storage, 'getItem' | 'setItem'>;
}

/** 产品默认装配；独立公开工厂不自动登记插件、联网或采集。 */
export function createBundledDebugger(options: BundledDebuggerOptions) {
  const { runtime } = options;
  const listeners = new Set<(snapshot: BundledDebuggerSnapshot) => void>();
  const preferenceKey = `deviceforge.bundled-debugger:${new URL(options.baseUrl).origin}`;
  const local = Boolean(runtime.debugger) && isLoopbackDebuggerAddress(options.baseUrl) &&
    isLoopbackDebuggerAddress(options.browserOrigin);
  let state: BundledDebuggerSnapshot = { phase: local ? 'idle' : 'unavailable', message: null };
  let started: Promise<void> | null = null;
  let queue: Promise<void> = Promise.resolve();
  let closed = false;
  let registered = false;
  let disabled = false;
  try { disabled = options.persistence?.getItem(preferenceKey) === 'disabled'; }
  catch { /* 浏览器禁止本地存储时仍允许当前页面使用调试器。 */ }
  function publish(phase: BundledDebuggerSnapshot['phase'], message: string | null = null) {
    if (closed) return;
    state = Object.freeze({ phase, message });
    for (const listener of [...listeners]) {
      try { listener(state); } catch { /* 状态订阅不能阻断插件启停。 */ }
    }
  }
  function active(signal: AbortSignal) {
    signal.throwIfAborted();
    runtime.host.signal.throwIfAborted();
    if (closed) throw new Error('调试器产品装配已关闭');
  }
  async function installed(signal: AbortSignal) {
    const packages = runtime.pluginPackages.snapshot('browser').result ??
      await runtime.pluginPackages.refresh('browser', signal);
    const installations = runtime.pluginInstallations.snapshot().result ??
      await runtime.pluginInstallations.refresh(signal);
    active(signal);
    return packages.data.some(item => item.id === BUNDLED_DEBUGGER_ID) || installations.data.some(
      item => item.components.some(component => component.kind === 'browser' && component.id === BUNDLED_DEBUGGER_ID));
  }
  function remember(enabled: boolean) {
    disabled = !enabled;
    try { options.persistence?.setItem(preferenceKey, enabled ? 'enabled' : 'disabled'); }
    catch { /* 当前页的启停仍然有效；无法持久化时不伪造服务器失败。 */ }
  }
  async function enable(signal: AbortSignal) {
    active(signal);
    if (!runtime.bundledPlugins.has(BUNDLED_DEBUGGER_ID)) {
      runtime.bundledPlugins.register({ id: BUNDLED_DEBUGGER_ID, trusted: true, loader: options.load });
      registered = true;
    }
    publish('loading');
    const cancel = () => { void runtime.webPlugins.unload(BUNDLED_DEBUGGER_ID).catch(() => undefined); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      await runtime.webPlugins.load(BUNDLED_DEBUGGER_ID);
      active(signal);
      remember(true);
      publish('loaded');
    } finally { signal.removeEventListener('abort', cancel); }
  }
  function serial(work: () => Promise<void>) {
    const pending = queue.then(work).catch((error: unknown) => {
      if (state.phase !== 'external') publish('failed', error instanceof Error ? error.message : '调试器加载失败，请查看插件诊断');
      throw error;
    });
    queue = pending.catch(() => undefined);
    return pending;
  }
  const unsubscribe = runtime.extensions.subscribe(() => {
    if (registered && !runtime.bundledPlugins.has(BUNDLED_DEBUGGER_ID))
      publish('external');
  });
  return {
    identity: Object.freeze({ id: BUNDLED_DEBUGGER_ID, version: BUNDLED_DEBUGGER_VERSION }),
    snapshot: () => state,
    subscribe(listener: (snapshot: BundledDebuggerSnapshot) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    start(signal: AbortSignal): Promise<void> {
      if (started) return started;
      started = serial(async () => {
        active(signal);
        if (!local) return;
        if (await installed(signal)) { publish('external'); return; }
        if (disabled) { publish('disabled'); return; }
        await enable(signal);
      });
      return started;
    },
    setEnabled(enabled: boolean, signal: AbortSignal) {
      return serial(async () => {
        active(signal);
        if (!local) throw new Error('调试器仅支持本机回环地址，请在本机打开 DeviceForge');
        if ((!runtime.bundledPlugins.has(BUNDLED_DEBUGGER_ID) && state.phase !== 'idle' && state.phase !== 'disabled' && state.phase !== 'failed') ||
          await installed(signal)) {
          publish('external');
          throw new Error('调试器已有独立安装，请使用原安装入口管理');
        }
        if (enabled) await enable(signal);
        else {
          remember(false);
          await runtime.webPlugins.unload(BUNDLED_DEBUGGER_ID);
          active(signal);
          publish('disabled');
        }
      });
    },
    dispose() { closed = true; unsubscribe(); listeners.clear(); },
  };
}
