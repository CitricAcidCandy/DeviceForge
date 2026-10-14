import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Expand,
  Minimize2,
  Menu,
  Smartphone,
  RefreshCw,
  ListChecks,
  Ellipsis,
  PanelLeftClose,
  PanelLeftOpen,
  ChevronRight,
  Radio,
  Unplug,
} from 'lucide-react';
import { Button } from '../../components/Button/index.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuCheckboxItem,
} from '../../components/DropdownMenu/index.tsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/Select/index.tsx';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '../../components/Sheet/index.tsx';
import type { ProductServices } from './services.ts';
import type { ProductRoute } from './routes.ts';
import { PRODUCT_ROUTES } from './routes.ts';
import { ProductNavigation } from './navigation.tsx';
import { useAction, useSnapshot } from './hooks.ts';
import { ErrorNotice } from './feedback.tsx';

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
  const devices = useSnapshot(services.runtime.devices);
  const connection = useAction();
  const discovery = useAction();
  const currentRoute = PRODUCT_ROUTES.find((entry) => entry.id === route);
  const available = devices.directories.flatMap((directory) => directory.devices);
  const selectionKey = devices.selection ? JSON.stringify(devices.selection) : 'none';
  const selectedDevice = available.find(
    (device) => JSON.stringify(device.reference) === selectionKey,
  );
  const connectionText = operations.pending
    ? '正在连接'
    : operations.error
      ? '服务器连接失败'
      : operations.result
        ? '服务器已连接'
        : '等待连接';
  const selectedState =
    selectedDevice?.state === 'online'
      ? '在线'
      : selectedDevice?.state === 'unauthorized'
        ? '待授权'
        : selectedDevice?.state === 'offline'
          ? '离线'
          : '状态未知';
  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(preference.matches);
    const changed = () => setReduced(preference.matches);
    preference.addEventListener('change', changed);
    void connection.run(services.runtime.operations.refresh);
    void discovery.run(services.runtime.devices.refreshDirectories);
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
      data-navigation-collapsed={collapsed}
    >
      <div className="workshop-scene" aria-hidden="true" />
      <a className="skip-link" href="#workplane">
        跳到工作区
      </a>
      <aside className="workspace-sidebar" aria-label="主导航区域">
        <Button
          variant="ghost"
          className="brand-lockup"
          onClick={() => navigate('devices')}
          aria-label="设备工坊首页"
        >
          <span className="brand-mark">
            F<span>·</span>
          </span>
          <span className="brand-name">
            DeviceForge<small>设备工坊</small>
          </span>
        </Button>
        <ProductNavigation route={route} collapsed={collapsed} onNavigate={navigate} />
        <div className="sidebar-footer">
          <span className="sidebar-footer-mark" aria-hidden="true" />
          <span className="navigation-label">连接设备，专注工作</span>
        </div>
      </aside>
      <div className="workspace-main">
        <header className="workspace-topbar global-bar">
          <div className="topbar-location">
            <Button
              variant="ghost"
              size="icon"
              className="navigation-collapse"
              aria-label={collapsed ? '展开导航' : '折叠导航'}
              aria-expanded={!collapsed}
              onClick={() => setCollapsed(!collapsed)}
            >
              {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
            </Button>
            <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
              <SheetTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="navigation-mobile-trigger"
                  aria-label="打开导航"
                >
                  <Menu />
                </Button>
              </SheetTrigger>
              <SheetContent
                side="left"
                className={'navigation-drawer' + (reduced ? ' reduce-motion' : '')}
              >
                <SheetHeader>
                  <SheetTitle>工坊导航</SheetTitle>
                  <SheetDescription>选择工具，继续当前设备工作</SheetDescription>
                </SheetHeader>
                <ProductNavigation route={route} onNavigate={navigate} />
              </SheetContent>
            </Sheet>
            <nav className="workspace-breadcrumb" aria-label="面包屑">
              <ol>
                <li>设备工坊</li>
                <li className="breadcrumb-group">
                  <ChevronRight aria-hidden="true" />
                  {currentRoute?.group}
                </li>
                <li aria-current="page">
                  <ChevronRight aria-hidden="true" />
                  <span>{currentRoute?.label}</span>
                </li>
              </ol>
            </nav>
          </div>
          <div className="global-actions">
            <span
              className={'connection-state' + (operations.error ? ' is-error' : '')}
              role="status"
            >
              <span className="connection-dot" aria-hidden="true" />
              <span>{connectionText}</span>
            </span>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                void connection.run(services.runtime.operations.refresh);
              }}
              aria-label="重新连接服务器"
            >
              <RefreshCw />
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="focus-toggle"
              onClick={() => {
                setFocused(!focused);
                setDrawerOpen(false);
              }}
              aria-pressed={focused}
              aria-label={focused ? '退出专注' : '专注'}
            >
              {focused ? <Minimize2 /> : <Expand />}
              <span>{focused ? '退出专注' : '专注'}</span>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="更多设置">
                  <Ellipsis />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuCheckboxItem checked={reduced} onCheckedChange={setReduced}>
                  减少动态效果
                </DropdownMenuCheckboxItem>
                <DropdownMenuItem onSelect={() => navigate('settings')}>
                  主题与设置
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => navigate('plugins')}>管理插件</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        <section className="device-context" aria-label="当前设备上下文">
          <div className="device-context-selector">
            <div className="device-context-icon">
              <Smartphone aria-hidden="true" />
            </div>
            <div className="device-context-selection">
              <span className="context-label">当前设备</span>
              <Select
                value={selectionKey}
                onValueChange={(key) => {
                  const chosen = available.find(
                    (device) => JSON.stringify(device.reference) === key,
                  );
                  services.runtime.devices.select(chosen?.reference ?? null);
                }}
              >
                <SelectTrigger aria-label="选择当前设备">
                  <SelectValue placeholder="选择设备" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">尚未选择设备</SelectItem>
                  {available.map((device) => (
                    <SelectItem
                      key={JSON.stringify(device.reference)}
                      value={JSON.stringify(device.reference)}
                    >
                      {device.model ?? device.reference.localId} ·{' '}
                      {device.state === 'online'
                        ? '在线'
                        : device.state === 'unauthorized'
                          ? '待授权'
                          : device.state === 'offline'
                            ? '离线'
                            : '状态未知'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {selectedDevice ? (
              <span className={'device-context-state text-state state-' + selectedDevice.state}>
                <Radio aria-hidden="true" />
                {selectedState}
              </span>
            ) : (
              <span className="device-context-state muted">
                <Unplug aria-hidden="true" />
                未选择设备
              </span>
            )}
          </div>
          <div className="device-context-actions">
            <Button variant="ghost" size="sm" onClick={() => navigate('devices')}>
              设备详情
            </Button>
            <Button
              variant="outline"
              size="sm"
              aria-label="打开任务与日志"
              onClick={() => navigate('tasks')}
            >
              <ListChecks />
              <span>任务与日志</span>
            </Button>
          </div>
        </section>
        <div className="workspace-content">
          <main id="workplane" className="workplane" tabIndex={-1} data-product-workspace>
            <ErrorNotice error={connection.error} />
            {children}
          </main>
          <aside className="device-summary" aria-label="当前设备摘要">
            <h2>当前设备</h2>
            <div
              className={'device-summary-illustration' + (selectedDevice ? '' : ' is-empty')}
              aria-hidden="true"
            >
              <Smartphone />
            </div>
            {selectedDevice ? (
              <>
                <h3>{selectedDevice.model ?? selectedDevice.reference.localId}</h3>
                <p className={'text-state state-' + selectedDevice.state}>
                  <Radio aria-hidden="true" />
                  {selectedState}
                </p>
                <dl className="device-summary-details">
                  <dt>设备 ID</dt>
                  <dd>{selectedDevice.reference.localId}</dd>
                  <dt>提供者</dt>
                  <dd>{selectedDevice.reference.providerId}</dd>
                  <dt>状态</dt>
                  <dd>{selectedState}</dd>
                </dl>
                <Button variant="outline" onClick={() => navigate('devices')}>
                  进入设备工作台
                </Button>
              </>
            ) : (
              <>
                <h3>尚未选择设备</h3>
                <p className="muted">从设备目录选择目标，查看当前状态并使用可用工具。</p>
                <Button variant="outline" onClick={() => navigate('devices')}>
                  选择设备
                </Button>
              </>
            )}
            <div className="device-summary-hint">
              <ListChecks aria-hidden="true" />
              <p>任务、日志和产物会保留在工坊中，便于继续工作。</p>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
