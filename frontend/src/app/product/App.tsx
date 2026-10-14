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
  return (
    <ProductShell services={services} route={route} onNavigate={navigate}>
      {PRODUCT_ROUTES.filter((entry) => visited.has(entry.id)).map((entry) => (
        <div key={entry.id} hidden={entry.id !== route} data-route={entry.id}>
          {entry.id === 'devices' ? (
            <DevicesPage services={services} />
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
  );
}
