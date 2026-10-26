import { useEffect, useState } from 'react';
import type { ProductRoute } from './routes.ts';
import { VISIBLE_ROUTES, hostRouteInfo, isPluginRoute, splitPluginRoute } from './routes.ts';
import { ProductNavigation } from './navigation.tsx';
import type { PluginPageInfo } from './slots.tsx';
import { Button } from '../../components/Button/index.tsx';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuTrigger,
} from '../../components/DropdownMenu/index.tsx';
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger,
} from '../../components/Sheet/index.tsx';
import { ChevronRight, Ellipsis, Menu, PanelLeftClose, PanelLeftOpen, RefreshCw, Settings2 } from 'lucide-react';

// 侧栏由品牌、服务状态、分组导航与底部小工具组成；不持有业务状态。
export function WorkspaceSidebar({
  route, pluginPages, replacedRoutes, collapsed, connectionText, connectionError, onNavigate,
}: {
  route: ProductRoute;
  pluginPages: readonly PluginPageInfo[];
  replacedRoutes: ReadonlySet<string>;
  collapsed: boolean;
  connectionText: string;
  connectionError: boolean;
  onNavigate(route: ProductRoute): void;
}) {
  return <aside id="workspace-sidebar" className="workspace-sidebar" aria-label="主导航区域">
    <Button variant="ghost" className="brand-lockup" onClick={() => onNavigate('devices')}
      aria-label="设备工坊首页" title="设备工坊首页">
      <span className="brand-mark" aria-hidden="true">F</span>
      <span className="brand-name">FORGE<small>设备工坊 DeviceForge</small></span>
    </Button>
    <div className="sidebar-service">
      <div className="sidebar-service-row">
        <span className="connection-dot" aria-hidden="true" />
        <span>本机服务</span>
        <span data-service-state={connectionError ? 'error' : 'ok'}>{connectionText}</span>
      </div>
    </div>
    <ProductNavigation
      route={route}
      pluginPages={pluginPages}
      replacedRoutes={replacedRoutes}
      collapsed={collapsed}
      onNavigate={onNavigate}
    />
    <div className="sidebar-foot">
      <Button variant="ghost" className="sidebar-foot-button" aria-label="设置" title="设置"
        onClick={() => onNavigate('settings')}><Settings2 aria-hidden="true" /></Button>
      <span className="sidebar-version">v0.1.0</span>
    </div>
  </aside>;
}

/** 顶栏里的当前设备身份：只报事实，动作留在设备页的目录卡里。 */
export interface WorkspaceIdentity {
  readonly name: string;
  readonly state: string;
  readonly meta: string;
}

export function WorkspaceHeader({
  route, pluginPages, replacedRoutes, collapsed, onCollapse, drawerOpen, onDrawerChange, reduced,
  onReducedChange, focused, onFocusedChange, connectionText, connectionError,
  onRefreshConnection, onNavigate, activeTasks, deviceSlot,
}: {
  route: ProductRoute;
  pluginPages: readonly PluginPageInfo[];
  replacedRoutes: ReadonlySet<string>;
  collapsed: boolean;
  onCollapse(): void;
  drawerOpen: boolean;
  onDrawerChange(open: boolean): void;
  reduced: boolean;
  onReducedChange(reduced: boolean): void;
  focused: boolean;
  onFocusedChange(focused: boolean): void;
  connectionText: string;
  connectionError: boolean;
  onRefreshConnection(): void;
  onNavigate(route: ProductRoute): void;
  activeTasks: number;
  /** 当前工作设备的选择器：挂在顶栏，不占页面正文，跨页面都在。 */
  deviceSlot?: React.ReactNode;
}) {
  // 插件页不在宿主路由表里，面包屑从插件自己声明的标题取，不让顶栏空着。
  const currentRoute = hostRouteInfo(route);
  const currentPlugin = isPluginRoute(route)
    ? pluginPages.find((page) => page.key === route)
    : undefined;
  const locationGroup = currentRoute?.group ?? '插件';
  const locationLabel =
    currentRoute?.label ??
    currentPlugin?.title ??
    (isPluginRoute(route) ? splitPluginRoute(route).page : '未知页面');
  return <header className="workspace-topbar global-bar">
    <div className="topbar-location">
      <Button variant="ghost" size="icon" className="navigation-desktop-trigger"
        onClick={onCollapse} aria-label={collapsed ? '展开侧边导航' : '折叠侧边导航'}
        aria-controls="workspace-sidebar" aria-expanded={!collapsed} title={collapsed ? '展开侧边导航' : '折叠侧边导航'}>
        {collapsed ? <PanelLeftOpen aria-hidden="true" /> : <PanelLeftClose aria-hidden="true" />}
      </Button>
      <Sheet open={drawerOpen} onOpenChange={onDrawerChange}>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon" className="navigation-mobile-trigger" aria-label="打开导航"><Menu /></Button>
        </SheetTrigger>
        <SheetContent side="left" className={'navigation-drawer' + (reduced ? ' reduce-motion' : '')}>
          <SheetHeader><SheetTitle>工坊导航</SheetTitle><SheetDescription>选择工具，继续当前设备工作</SheetDescription></SheetHeader>
          <ProductNavigation
            route={route}
            pluginPages={pluginPages}
            replacedRoutes={replacedRoutes}
            onNavigate={onNavigate}
          />
        </SheetContent>
      </Sheet>
      <nav className="workspace-breadcrumb" aria-label="面包屑"><ol>
        <li className="breadcrumb-group">{locationGroup}</li>
        <li aria-current="page"><ChevronRight aria-hidden="true" /><span>{locationLabel}</span></li>
      </ol></nav>
      {deviceSlot}
    </div>
    <div className="global-actions">
      <span className="command-hint" aria-hidden="true">搜索或运行命令<kbd>Ctrl K</kbd></span>
      <span className={'connection-state' + (connectionError ? ' is-error' : '')} role="status">
        <span className="connection-dot" aria-hidden="true" /><span>{connectionText}</span>
      </span>
      {activeTasks > 0 && <span className="dock-count" aria-label={`${activeTasks} 个任务进行中`}>{activeTasks} 进行中</span>}
      <Button
        variant={focused ? 'secondary' : 'ghost'}
        size="sm"
        onClick={() => onFocusedChange(!focused)}
        aria-pressed={focused}
        title={focused ? '退出专注，恢复侧栏与任务坞' : '专注画面，收起侧栏与任务坞'}
      >
        {focused ? '退出专注' : '专注'}
      </Button>
      <Button variant="ghost" size="icon" className="header-reconnect" onClick={onRefreshConnection} aria-label="重新连接服务器">
        <RefreshCw aria-hidden="true" />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label="更多设置"><Ellipsis /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onRefreshConnection}>重新连接服务器</DropdownMenuItem>
          <DropdownMenuCheckboxItem checked={reduced} onCheckedChange={onReducedChange}>减少动态效果</DropdownMenuCheckboxItem>
          <DropdownMenuItem onSelect={() => onNavigate('settings')}>主题与设置</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onNavigate('marketplace')}>管理插件</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </header>;
}

// 状态栏只报运行事实：连接、插件装载与可排查的日志标识。
export function WorkspaceStatusBar({
  pluginPages, connectionText, connectionError, pluginCount, logId, endpoint,
}: {
  pluginPages: readonly PluginPageInfo[];
  connectionText: string;
  connectionError: boolean;
  pluginCount: number;
  logId: string | null;
  endpoint: string | null;
}) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const time = new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(now);
  return <div className="workspace-statusbar" role="contentinfo" aria-label="运行状态">
    <div className="statusbar-group">
      <span>{connectionError ? '连接异常' : connectionText}</span>
      {endpoint && <><span className="statusbar-divider" aria-hidden="true" /><span>{endpoint}</span></>}
      <span className="statusbar-divider" aria-hidden="true" />
      <span>插件 {pluginCount} 已加载</span>
      <span className="statusbar-divider" aria-hidden="true" />
      <span>
        路由 宿主 {VISIBLE_ROUTES.length} + 插件 {pluginPages.length}
      </span>
    </div>
    <div className="statusbar-group">
      {logId && <><span className="statusbar-log">日志 {logId}</span><span className="statusbar-divider" aria-hidden="true" /></>}
      <span>Ctrl K 命令</span>
      <span className="statusbar-divider" aria-hidden="true" />
      <span>{time}</span>
    </div>
  </div>;
}
