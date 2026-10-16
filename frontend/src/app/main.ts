import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import './styles.css';
import './product/layout.css';
import { App } from './product/App.tsx';
import { createProductServices } from './product/services.ts';
import type { ProductServices } from './product/services.ts';
import { createNamedSlotAdapter } from '../plugins/index.ts';
import { productServiceOrigin, probeProductConnection } from './product/connection.ts';
import { createInstalledPackageImporter } from './installed-package-importer.ts';
import { ApiError } from '../services/api/index.ts';

export async function startFrontendApp(documentRef: Document, windowRef: Window) {
  const target = documentRef.getElementById('app');
  if (!target) throw new Error('应用挂载节点不存在');
  // 主题变量同时覆盖工作区与官方弹层挂载根，释放时由主题适配器恢复。
  const themeRoot = documentRef.documentElement;
  const application = documentRef.createElement('div');
  const extensions = documentRef.createElement('section');
  application.id = 'product-root';
  extensions.className = 'plugin-extension-root';
  extensions.setAttribute('aria-label', '插件工作区');
  target.append(application, extensions);
  const panel = documentRef.createElement('div');
  const component = documentRef.createElement('div');
  const module = documentRef.createElement('div');
  panel.dataset.pluginPanels = '';
  component.dataset.pluginComponents = '';
  module.dataset.pluginModules = '';
  extensions.append(panel, component, module);
  const slots = await createNamedSlotAdapter([
    {
      id: 'workshop.extensions',
      target: component,
      renderDefault(slotRoot) {
        const link = documentRef.createElement('a');
        link.href = '#plugins';
        link.className = 'skip-link';
        link.textContent = '管理工坊扩展';
        slotRoot.append(link);
        return () => link.remove();
      },
    },
  ]);
  const root = createRoot(application);
  let services: ProductServices | null = null;
  let closing: Promise<void> | null = null;
  let switching = false;
  const lifetime = new AbortController();
  async function connect(baseUrl: string, token: string, signal: AbortSignal) {
    const origin = productServiceOrigin(baseUrl);
    if (closing || switching) throw new Error('运行实例正在切换或关闭');
    switching = true;
    try {
      if (services)
        await probeProductConnection(
          origin,
          token,
          windowRef.fetch.bind(windowRef),
          AbortSignal.any([signal, lifetime.signal]),
        );
      if (lifetime.signal.aborted || signal.aborted) throw new Error('服务连接切换已取消');
      if (services) {
        flushSync(() => root.render(null));
        await services.dispose();
      }
      if (lifetime.signal.aborted) throw new Error('页面已关闭');
      services = createProductServices({
        baseUrl: origin,
        transport: windowRef.fetch.bind(windowRef),
        esmImporter: createInstalledPackageImporter(origin),
        tokenProvider: () => token || null,
        panelTarget: () => panel,
        componentTarget: () => component,
        moduleTarget: () => module,
        slotAdapter: slots,
        themeTarget: themeRoot,
        connection: { baseUrl: origin, reconnect: connect },
      });
      root.render(createElement(App, { services }));
      // 产品启动默认启用已安装插件；独立工厂的构造和静态渲染保持无网络副作用。
      const currentServices = services;
      void currentServices.pluginDefaults.start(lifetime.signal).catch((error) => {
        if (lifetime.signal.aborted || (error instanceof ApiError && error.kind === 'cancelled'))
          return;
        currentServices.messages.error('插件默认启用未完成', {
          description: error instanceof Error ? error.message : '请到插件页重新执行默认启用。',
          logId: error instanceof ApiError ? error.logId : null,
        });
        console.error('默认启用插件失败', error instanceof Error ? error.message : '未知原因');
      });
    } finally {
      switching = false;
    }
  }
  const configuredOrigin = import.meta.env['VITE_API_BASE_URL'];
  const initialOrigin = new URL(windowRef.location.origin);
  if (import.meta.env.DEV) initialOrigin.port = '7031';
  await connect(typeof configuredOrigin === 'string' && configuredOrigin ? configuredOrigin : initialOrigin.origin, '', lifetime.signal);
  const dispose = () => {
    closing ??= (async () => {
      lifetime.abort();
      root.unmount();
      const results = [
        await Promise.resolve(services?.dispose()).then(
          () => ({ status: 'fulfilled' as const }),
          (reason) => ({ status: 'rejected' as const, reason }),
        ),
        await slots.dispose().then(
          () => ({ status: 'fulfilled' as const }),
          (reason) => ({ status: 'rejected' as const, reason }),
        ),
      ];
      application.remove();
      extensions.remove();
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (failures.length) throw new AggregateError(failures, '前端应用关闭失败');
    })();
    return closing;
  };
  windowRef.addEventListener(
    'pagehide',
    () => {
      void dispose().catch((error) =>
        console.error('前端清理失败', error instanceof Error ? error.message : '未知原因'),
      );
    },
    { once: true },
  );
  return {
    get runtime() {
      return services?.runtime;
    },
    dispose,
  };
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  void startFrontendApp(document, window).catch((error) => {
    const target = document.getElementById('app');
    if (target)
      target.textContent =
        error instanceof Error ? `工坊启动失败：${error.message}` : '工坊启动失败';
  });
}
