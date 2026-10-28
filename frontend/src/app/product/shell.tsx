import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { ProductServices } from './services.ts';
import type { ProductRoute } from './routes.ts';
import { useReplacedHostRoutes } from './slots.tsx';
import type { PluginPageInfo } from './slots.tsx';
import { WorkspaceHeader, WorkspaceSidebar, WorkspaceStatusBar } from './chrome.tsx';
import { useAction, useSnapshot } from './hooks.ts';
import { DeviceContext } from './device-context.tsx';
import { WorkspaceTasks } from './workspace-tasks.tsx';
import { usePageTasks } from './use-page-tasks.ts';
import { taskBelongsToRoute } from './task-scope.ts';

export function ProductShell({
  services,
  route,
  pluginPages,
  onNavigate,
  children,
}: {
  services: ProductServices;
  route: ProductRoute;
  pluginPages: readonly PluginPageInfo[];
  onNavigate(route: ProductRoute): void;
  children: ReactNode;
}) {
  const [focused, setFocused] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const replacedRoutes = useReplacedHostRoutes(services);
  const operations = useSnapshot(services.runtime.operations);
  const devices = useSnapshot(services.runtime.devices);
  const connection = useAction();
  const discovery = useAction();
  const history = usePageTasks(services, false);
  const connectionText = operations.pending
    ? '正在连接'
    : operations.error
      ? '服务器连接失败'
      : operations.result
        ? '服务器已连接'
        : '等待连接';
  // 代次内已装载的浏览器插件数；数值只报事实，不做聚合推断。
  const pluginCount = services.runtime.webPlugins.snapshot().length;
  const activeTasks = history.jobs.filter(
    (job) =>
      (job.status === 'queued' || job.status === 'running') &&
      taskBelongsToRoute(
        job.operation,
        route,
        new Set(
          devices.providers.flatMap((provider) => [
            provider.definition.discoverOperation,
            ...provider.definition.capabilities.map((capability) => capability.operation),
          ]),
        ),
      ),
  ).length;
  let endpoint: string | null = null;
  try {
    endpoint = new URL(services.baseUrl).host;
  } catch {
    endpoint = services.baseUrl;
  }
  // 顶栏身份：当前选中的设备跨页面都需要被看见，这里只拼一条事实行。
  // 状态文案与设备页的 deviceStates 保持一致；颜色之外必须给出文字，颜色不是唯一信息。
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
      <WorkspaceSidebar
        route={route}
        pluginPages={pluginPages}
        replacedRoutes={replacedRoutes}
        collapsed={collapsed}
        connectionText={connectionText}
        connectionError={Boolean(operations.error)}
        onNavigate={navigate}
      />
      <div className="workspace-column">
        <WorkspaceHeader
          route={route}
          pluginPages={pluginPages}
          replacedRoutes={replacedRoutes}
          collapsed={collapsed}
          onCollapse={() => setCollapsed((value) => !value)}
          drawerOpen={drawerOpen}
          onDrawerChange={setDrawerOpen}
          reduced={reduced}
          onReducedChange={setReduced}
          focused={focused}
          onFocusedChange={(next) => {
            setFocused(next);
            setDrawerOpen(false);
          }}
          connectionText={connectionText}
          connectionError={Boolean(operations.error)}
          onRefreshConnection={() => {
            void connection.run(
              async (signal) => {
                const result = await services.runtime.operations.refresh(signal);
                if (
                  services.pluginDefaults
                    .snapshot()
                    .results.some((item) => item.status === 'failed')
                )
                  await services.pluginDefaults.retryFailures(signal);
                return result;
              },
              { pending: '正在重新连接服务器…', success: null },
            );
          }}
          onNavigate={navigate}
          activeTasks={activeTasks}
          deviceSlot={route === 'devices' ? null : <DeviceContext services={services} />}
        />
        <div className="workspace-main">
          <div className="workspace-content">
            <main
              id="workplane"
              className={route === 'settings'
                ? 'workplane overflow-hidden! bg-card! p-0! [scrollbar-gutter:auto]!'
                : 'workplane'}
              tabIndex={-1}
              data-product-workspace
            >
              {children}            </main>
          </div>
        </div>
        {/* 任务只留底部一行状态文本，细节从下往上弹出。 */}
        <WorkspaceTasks
          key={route}
          services={services}
          route={route}
          onNavigate={navigate}
          history={history}
          activeCount={activeTasks}
        />
      </div>
      <WorkspaceStatusBar
        pluginPages={pluginPages}
        connectionText={connectionText}
        connectionError={Boolean(operations.error)}
        pluginCount={pluginCount}
        logId={connection.logId ?? operations.result?.logId ?? null}
        endpoint={endpoint}
      />
    </div>
  );
}
