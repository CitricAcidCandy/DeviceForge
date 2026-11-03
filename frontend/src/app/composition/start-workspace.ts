import type { Dispose } from '../../plugin-sdk/index.ts';
import type { ProductPlatformServices } from '../product/platform-services.ts';
import { createDeviceViewsBridge } from '../product/device-views.tsx';
import { createLegacyCompositionAdapter } from './legacy-adapters.ts';
import { startShellSelection } from './shell-selection.ts';

export interface WorkspaceStartupOptions {
  readonly services: ProductPlatformServices;
  readonly officialIds: ReadonlySet<string>;
  readonly signal: AbortSignal;
  readonly selection: {
    readonly key: string;
    readonly persistence?: Pick<Storage, 'getItem' | 'setItem'>;
  };
  readonly report: (label: string, error: unknown) => void;
}

/** 外壳选择、兼容桥和官方插件独立启动，慢业务不占住首屏。 */
export function startWorkspace(options: WorkspaceStartupOptions): Dispose {
  const { services, signal } = options;
  const { runtime } = services;
  const lifetime = new AbortController();
  const combined = AbortSignal.any([signal, runtime.host.signal, lifetime.signal]);
  combined.throwIfAborted();
  const releaseSelection = startShellSelection(runtime.host, options.officialIds, {
    ...options.selection,
    providerReady: (pluginId, generation) => runtime.webPlugins.diagnosticSnapshot()
      .some((entry) => entry.id === pluginId && entry.generation === generation && entry.state === 'loaded'),
  });
  function launch(label: string, start: () => Promise<unknown>) {
    void Promise.resolve().then(() => {
      combined.throwIfAborted();
      return start();
    }).catch((error: unknown) => {
      if (!combined.aborted) options.report(label, error);
    });
  }
  launch('设备画面适配暂未启动', async () => {
    const plugin = createDeviceViewsBridge(services);
    runtime.bundledPlugins.register({ id: plugin.id, trusted: true, plugin });
    await runtime.webPlugins.load(plugin.id);
  });
  launch('兼容扩展适配暂未启动', async () => {
    const plugin = createLegacyCompositionAdapter(runtime.extensions);
    runtime.bundledPlugins.register({ id: plugin.id, trusted: true, plugin });
    await runtime.webPlugins.load(plugin.id);
  });
  launch('插件工作区启动未完成', async () => services.officialPlugins?.start(combined));
  // 安装归属由调试器复用原目录确认；无关默认启用或慢业务不挡住全局入口。
  launch('官方调试器暂未启动', async () => services.bundledDebugger?.start(combined));
  let closing: Promise<void> | null = null;
  function dispose(): Promise<void> {
    closing ??= (async () => {
      combined.removeEventListener('abort', aborted);
      lifetime.abort();
      await releaseSelection();
    })();
    return closing;
  }
  const aborted = () => {
    void dispose().catch((error: unknown) => options.report('工作区启动订阅回收未确认', error));
  };
  combined.addEventListener('abort', aborted, { once: true });
  if (combined.aborted) aborted();
  return dispose;
}
