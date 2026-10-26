import { useEffect, useState } from 'react';
import type { ProductServices } from './services.ts';
import { PRODUCT_ROUTES, isPluginRoute, parseProductRoute, routeHash } from './routes.ts';
import type { ProductRoute } from './routes.ts';
import { ProductShell } from './shell.tsx';
import { RouteSurface, usePluginPages } from './slots.tsx';
import { DevicesPage } from '../../pages/devices/index.tsx';
import { TasksPage } from '../../pages/tasks/index.tsx';
import { SettingsPage } from '../../pages/settings/index.tsx';
import { MarketplacePage } from '../../pages/marketplace/index.tsx';
import { AdvancedPage } from './advanced.tsx';
import { MessageProvider } from '../../components/Message/index.tsx';

/** 插件页面在模块装载完成前只有这一行；正常路径上它一瞬都看不见。 */
function PluginPagePending() {
  return (
    <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
      插件页面正在装载…
    </div>
  );
}

export function App({ services }: { services: ProductServices }) {
  const [route, setRoute] = useState<ProductRoute>(() =>
    typeof window === 'undefined' ? 'devices' : parseProductRoute(window.location.hash),
  );
  const [visited, setVisited] = useState<ReadonlySet<ProductRoute>>(() => new Set([route]));
  const pluginPages = usePluginPages(services);
  function navigate(next: ProductRoute) {
    setRoute(next);
    setVisited((current) => new Set([...current, next]));
    if (typeof window !== 'undefined') window.location.hash = routeHash(next);
  }
  useEffect(() => {
    const changed = () => {
      const next = parseProductRoute(window.location.hash);
      setRoute(next);
      setVisited((current) => new Set([...current, next]));
    };
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  // 插件被卸载或禁用后，停在它页面上的用户必须被送回一个真实存在的地方。
  const pluginPageMissing = isPluginRoute(route) && !pluginPages.some((page) => page.key === route);
  useEffect(() => {
    if (pluginPageMissing) navigate('devices');
    // navigate 依赖的只有 setState，按缺失状态变化触发即可。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pluginPageMissing]);
  useEffect(() => {
    let reported = '';
    const report = (snapshot: ReturnType<typeof services.pluginDefaults.snapshot>) => {
      if (snapshot.phase === 'running') {
        reported = '';
        services.messages.dismiss('plugin-default-failures');
        return;
      }
      if (snapshot.phase !== 'completed') return;
      const failures = snapshot.results.filter((entry) => entry.status === 'failed');
      if (!failures.length) {
        reported = '';
        services.messages.dismiss('plugin-default-failures');
        return;
      }
      const signature = JSON.stringify([snapshot.round, failures]);
      if (signature === reported) return;
      reported = signature;
      services.messages.warning(`有 ${failures.length} 项插件未能默认启用`, {
        id: 'plugin-default-failures',
        description: '可到市场页「已安装」重试失败项。',
        details: failures.map((entry) => ({
          label: `${entry.kind === 'server' ? '服务器' : '浏览器'} · ${entry.id ?? '插件目录'}`,
          message: entry.message ?? '启用失败',
          logId: entry.logId,
        })),
      });
    };
    // 启动可能早于页面 effect 完成，先订阅再补读当前快照。
    const unsubscribe = services.pluginDefaults.subscribe(report);
    report(services.pluginDefaults.snapshot());
    return unsubscribe;
  }, [services]);
  return (
    <MessageProvider controller={services.messages}>
      <ProductShell
        services={services}
        route={route}
        pluginPages={pluginPages}
        onNavigate={navigate}
      >
        {PRODUCT_ROUTES.filter((entry) => visited.has(entry.id)).map((entry) => (
          <div
            key={entry.id}
            hidden={entry.id !== route}
            data-route={entry.id}
            className={entry.id === 'automation' ? 'flex min-h-full w-full flex-col' : undefined}
          >
            <RouteSurface services={services} route={entry.id}>
              {entry.id === 'devices' ? (
                <DevicesPage services={services} active={route === 'devices'} />
              ) : entry.id === 'tasks' ? (
                <TasksPage services={services} />
              ) : entry.id === 'settings' ? (
                <SettingsPage services={services} />
              ) : entry.id === 'marketplace' ? (
                <MarketplacePage services={services} active={route === 'marketplace'} />
              ) : (
                <AdvancedPage route={entry.id} services={services} active={entry.id === route} />
              )}
            </RouteSurface>
          </div>
        ))}
        {/* 插件页面不进宿主路由表：它们由插件自己声明，卸载即消失，已访问集里自然被清掉。 */}
        {pluginPages
          .filter((page) => visited.has(page.key))
          .map((page) => (
            <div
              key={page.key}
              hidden={page.key !== route}
              data-plugin-page={page.key}
              className="flex min-h-full w-full min-w-0 flex-col"
            >
              <RouteSurface services={services} route={page.key}>
                <PluginPagePending />
              </RouteSurface>
            </div>
          ))}
      </ProductShell>
    </MessageProvider>
  );
}
