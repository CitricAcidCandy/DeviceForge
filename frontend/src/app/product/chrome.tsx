import { useEffect, useState } from 'react';
import type { ProductRoute } from './routes.ts';
import { PRODUCT_ROUTES } from './routes.ts';
import { ProductNavigation } from './navigation.tsx';
import { Button } from '../../components/Button/index.tsx';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuTrigger,
} from '../../components/DropdownMenu/index.tsx';
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger,
} from '../../components/Sheet/index.tsx';
import {
  ChevronRight, Ellipsis, Expand, Menu, Minimize2,
  PanelLeftClose, PanelLeftOpen, RefreshCw,
} from 'lucide-react';

export function WorkspaceSidebar({ route, collapsed, onNavigate }: {
  route: ProductRoute;
  collapsed: boolean;
  onNavigate(route: ProductRoute): void;
}) {
  return <aside id="workspace-sidebar" className="workspace-sidebar" aria-label="主导航区域">
    <ProductNavigation route={route} collapsed={collapsed} onNavigate={onNavigate} />
  </aside>;
}

export function WorkspaceHeader({
  route, collapsed, onCollapse, drawerOpen, onDrawerChange, reduced, onReducedChange,
  focused, onFocusedChange, connectionText, connectionError,
  onRefreshConnection, onNavigate,
}: {
  route: ProductRoute;
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
}) {
  const currentRoute = PRODUCT_ROUTES.find((entry) => entry.id === route);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const date = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  }).format(now);
  const time = new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(now);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return <header className="workspace-topbar global-bar">
    <Button variant="ghost" className="header-brand" onClick={() => onNavigate('devices')}
      aria-label="设备工坊首页" title="设备工坊首页">
      <span className="brand-mark">F<span>·</span></span>
      <span className="brand-name">DeviceForge<small>设备工坊</small></span>
    </Button>
    <div className="workspace-toolbar">
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
            <ProductNavigation route={route} onNavigate={onNavigate} />
          </SheetContent>
        </Sheet>
        <nav className="workspace-breadcrumb" aria-label="面包屑"><ol>
          <li>设备工坊</li>
          <li className="breadcrumb-group"><ChevronRight aria-hidden="true" />{currentRoute?.group}</li>
          <li aria-current="page"><ChevronRight aria-hidden="true" /><span>{currentRoute?.label}</span></li>
        </ol></nav>
      </div>
      <div className="header-clock" aria-label="当前时间">
        <span>{date}</span>
        <time dateTime={now.toISOString()}>{time}</time>
        <span>{timeZone}</span>
      </div>
      <div className="global-actions">
        <span className={'connection-state' + (connectionError ? ' is-error' : '')} role="status">
          <span className="connection-dot" aria-hidden="true" /><span>{connectionText}</span>
        </span>
        <Button variant="ghost" size="icon" className="header-reconnect" onClick={onRefreshConnection} aria-label="重新连接服务器"><RefreshCw /></Button>
        <Button variant="outline" size="sm" className="focus-toggle" onClick={() => onFocusedChange(!focused)}
          aria-pressed={focused} aria-label={focused ? '退出专注' : '专注'}>
          {focused ? <Minimize2 /> : <Expand />}<span>{focused ? '退出专注' : '专注'}</span>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label="更多设置"><Ellipsis /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem className="compact-header-action" onSelect={onRefreshConnection}>重新连接服务器</DropdownMenuItem>
            <DropdownMenuItem className="compact-header-action" onSelect={() => onFocusedChange(!focused)}>{focused ? '退出专注' : '专注模式'}</DropdownMenuItem>
            <DropdownMenuCheckboxItem checked={reduced} onCheckedChange={onReducedChange}>减少动态效果</DropdownMenuCheckboxItem>
            <DropdownMenuItem onSelect={() => onNavigate('settings')}>主题与设置</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onNavigate('plugins')}>管理插件</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  </header>;
}
