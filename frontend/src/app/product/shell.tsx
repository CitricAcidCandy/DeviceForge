import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { ProductServices } from './services.ts';
import type { ProductRoute } from './routes.ts';
import { WorkspaceHeader, WorkspaceSidebar } from './chrome.tsx';
import { useAction, useSnapshot } from './hooks.ts';
import { DeviceContext } from './device-context.tsx';
import { WorkspaceTasks } from './workspace-tasks.tsx';

export function ProductShell({
  services,
  route,
  onNavigate,
  children,
}: {
  services: ProductServices;
  route: ProductRoute;
  onNavigate(route: ProductRoute): void;
  children: ReactNode;
}) {
  const [focused, setFocused] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const operations = useSnapshot(services.runtime.operations);
  const connection = useAction();
  const discovery = useAction();
  const connectionText = operations.pending
    ? '正在连接'
    : operations.error
      ? '服务器连接失败'
      : operations.result
        ? '服务器已连接'
        : '等待连接';
  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(preference.matches);
    const changed = () => setReduced(preference.matches);
    preference.addEventListener('change', changed);
    void connection.run(services.runtime.operations.refresh, { quiet: true });
    void discovery.run(services.runtime.devices.refreshDirectories, { quiet: true });
    return () => preference.removeEventListener('change', changed);
  }, [services]);
  function navigate(next: ProductRoute) {
    onNavigate(next);
    setDrawerOpen(false);
  }
  return (
    <div
      className={
        'product-shell' + (focused ? ' is-focused' : '') + (reduced ? ' reduce-motion' : '')
      }
      data-route={route}
      data-navigation-collapsed={collapsed}
    >
      <div className="workshop-scene" aria-hidden="true" />
      <a className="skip-link" href="#workplane">
        跳到工作区
      </a>
      <WorkspaceHeader
        route={route}
        collapsed={collapsed}
        onCollapse={() => setCollapsed((value) => !value)}
        drawerOpen={drawerOpen}
        onDrawerChange={setDrawerOpen}
        reduced={reduced}
        onReducedChange={setReduced}
        focused={focused}
        onFocusedChange={(next) => { setFocused(next); setDrawerOpen(false); }}
        connectionText={connectionText}
        connectionError={Boolean(operations.error)}
        onRefreshConnection={() => {
          void connection.run(async (signal) => {
            const result = await services.runtime.operations.refresh(signal);
            if (services.pluginDefaults.snapshot().results.some((item) => item.status === 'failed'))
              await services.pluginDefaults.retryFailures(signal);
            return result;
          }, { pending: '正在重新连接服务器…', success: null });
        }}
        onNavigate={navigate}
      />
      <WorkspaceSidebar route={route} collapsed={collapsed} onCollapse={() => setCollapsed(!collapsed)} onNavigate={navigate} />
      <div className="workspace-main">
        <div className="workspace-content">
          <main id="workplane" className="workplane" tabIndex={-1} data-product-workspace>
            {(['packages', 'media', 'performance', 'frida', 'automation'] as readonly ProductRoute[]).includes(route) && <DeviceContext services={services} />}
            {children}
          </main>
        </div>
        <WorkspaceTasks key={route} services={services} route={route} onNavigate={navigate} />
      </div>
    </div>
  );
}
