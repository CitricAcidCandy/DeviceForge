import { useEffect, useState } from 'react';
import type { ProductServices } from './services.ts';
import { PRODUCT_ROUTES, parseProductRoute } from './routes.ts';
import type { ProductRoute } from './routes.ts';
import { ProductShell } from './shell.tsx';
import { DevicesPage } from '../../pages/devices/index.tsx';
import { PluginsPage } from '../../pages/plugins/index.tsx';
import { TasksPage } from '../../pages/tasks/index.tsx';
import { SettingsPage } from '../../pages/settings/index.tsx';
import { AdvancedPage } from './advanced.tsx';
import { MessageProvider } from '../../components/Message/index.tsx';

export function App({ services }: { services: ProductServices }) {
  const [route, setRoute] = useState<ProductRoute>(() =>
    typeof window === 'undefined' ? 'devices' : parseProductRoute(window.location.hash),
  );
  const [visited, setVisited] = useState<ReadonlySet<ProductRoute>>(() => new Set([route]));
  function navigate(next: ProductRoute) {
    setRoute(next);
    setVisited((current) => new Set([...current, next]));
    if (typeof window !== 'undefined') window.location.hash = next;
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
        description: '可到插件页重试失败项。',
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
      <ProductShell services={services} route={route} onNavigate={navigate}>
        {PRODUCT_ROUTES.filter((entry) => visited.has(entry.id)).map((entry) => (
          <div key={entry.id} hidden={entry.id !== route} data-route={entry.id}>
            {entry.id === 'devices' ? (
              <DevicesPage services={services} active={route === 'devices'} />
            ) : entry.id === 'plugins' ? (
              <PluginsPage services={services} />
            ) : entry.id === 'tasks' ? (
              <TasksPage services={services} />
            ) : entry.id === 'settings' ? (
              <SettingsPage services={services} />
            ) : (
              <AdvancedPage route={entry.id} services={services} />
            )}
          </div>
        ))}
      </ProductShell>
    </MessageProvider>
  );
}
