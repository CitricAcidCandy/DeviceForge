import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowUpRight, Expand, Minimize2, Menu, Smartphone, RefreshCw, ListChecks, Ellipsis } from 'lucide-react';
import { Button } from '../../shared/ui/components/button.tsx';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuCheckboxItem } from '../../shared/ui/components/dropdown-menu.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../shared/ui/components/select.tsx';
import type { ProductServices } from './services.ts';
import type { ProductRoute } from './routes.ts';
import { PRODUCT_ROUTES } from './routes.ts';
import { useAction, useSnapshot } from './hooks.ts';
import { ErrorNotice } from './common.tsx';

export function ProductShell({ services, route, onNavigate, children }: { services: ProductServices; route: ProductRoute; onNavigate(route: ProductRoute): void; children: ReactNode }) {
  const [focused, setFocused] = useState(false);
  const [reduced, setReduced] = useState(false);
  const operations = useSnapshot(services.runtime.operations);
  const devices = useSnapshot(services.runtime.devices);
  const connection = useAction();
  const discovery = useAction();
  const currentRoute = PRODUCT_ROUTES.find((entry) => entry.id === route);
  const available = devices.directories.flatMap((directory) => directory.devices);
  const selectionKey = devices.selection ? JSON.stringify(devices.selection) : 'none';
  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(preference.matches);
    const changed = () => setReduced(preference.matches);
    preference.addEventListener('change', changed);
    void connection.run(services.runtime.operations.refresh);
    void discovery.run(services.runtime.devices.refreshDirectories);
    return () => preference.removeEventListener('change', changed);
  }, [services]);
  return <div className={`product-shell${focused ? ' is-focused' : ''}${reduced ? ' reduce-motion' : ''}`}>
    <div className="workshop-scene" aria-hidden="true" />
    <a className="skip-link" href="#workplane">跳到工作区</a>
    <header className="global-bar">
      <Button variant="ghost" className="brand-lockup" onClick={() => onNavigate('devices')} aria-label="设备工坊首页"><span className="brand-mark">FORGE<span>·</span></span><span className="brand-name">设备工坊</span></Button>
      <div className="global-actions"><span className={`connection-state${operations.error ? ' is-error' : ''}`} role="status">{operations.pending ? '正在连接' : operations.error ? '服务器连接失败' : operations.result ? '服务器已连接' : '等待连接'}</span>
        <Button variant="ghost" size="sm" onClick={() => { void connection.run(services.runtime.operations.refresh); }} aria-label="重新连接服务器"><RefreshCw /></Button>
        <Button variant="outline" size="sm" onClick={() => setFocused(!focused)} aria-pressed={focused}>{focused ? <Minimize2 /> : <Expand />}<span>{focused ? '退出专注' : '专注'}</span></Button>
        <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label="更多设置"><Ellipsis /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuCheckboxItem checked={reduced} onCheckedChange={setReduced}>减少动态效果</DropdownMenuCheckboxItem><DropdownMenuItem onSelect={() => onNavigate('settings')}>主题与设置</DropdownMenuItem><DropdownMenuItem onSelect={() => onNavigate('plugins')}>管理插件</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
      </div>
    </header>
    <div className="scene-caption" aria-hidden="true"><span>让设备，连接更多可能</span><span>YOUR EVERYDAY WORKSHOP <ArrowUpRight /></span></div>
    <nav className="tool-navigation" aria-label="工坊工具">
      <div className="desktop-tools">{PRODUCT_ROUTES.map((entry) => <Button key={entry.id} variant="ghost" className={route === entry.id ? 'tool-link is-current' : 'tool-link'} aria-current={route === entry.id ? 'page' : undefined} onClick={() => onNavigate(entry.id)}>{entry.label}</Button>)}</div>
      <div className="compact-tools"><span>{currentRoute?.label}</span><DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost"><Menu />全部工具</Button></DropdownMenuTrigger><DropdownMenuContent align="end" className="all-tools-menu">{PRODUCT_ROUTES.map((entry) => <DropdownMenuItem key={entry.id} onSelect={() => onNavigate(entry.id)}><entry.icon />{entry.label}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu></div>
    </nav>
    <main id="workplane" className="workplane" tabIndex={-1} data-product-workspace><ErrorNotice error={connection.error} />{children}</main>
    <footer className="device-dock"><div className="dock-device"><Smartphone aria-hidden="true" /><Select value={selectionKey} onValueChange={(key) => { const chosen = available.find((device) => JSON.stringify(device.reference) === key); services.runtime.devices.select(chosen?.reference ?? null); }}><SelectTrigger aria-label="选择当前设备"><SelectValue placeholder="选择设备" /></SelectTrigger><SelectContent><SelectItem value="none">尚未选择设备</SelectItem>{available.map((device) => <SelectItem key={JSON.stringify(device.reference)} value={JSON.stringify(device.reference)}>{device.model ?? device.reference.localId} · {device.state === 'online' ? '在线' : device.state === 'unauthorized' ? '待授权' : device.state === 'offline' ? '离线' : '状态未知'}</SelectItem>)}</SelectContent></Select><Button variant="ghost" size="sm" onClick={() => onNavigate('devices')}>设备详情</Button></div><Button variant="ghost" aria-label="打开任务与日志" onClick={() => onNavigate('tasks')}><ListChecks />任务与日志</Button></footer>
  </div>;
}
