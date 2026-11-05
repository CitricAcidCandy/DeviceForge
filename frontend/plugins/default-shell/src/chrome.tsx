import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { ShellState } from './controller.ts';
import type { ShellConnection } from './connection.ts';
import type { ShellFacts } from './facts-rules.ts';
import { waiting } from './facts-rules.ts';
import { normalizeRoute } from './controller.ts';
import { MoreSettings } from './more-menu.tsx';
import { SheetTrigger } from '@deviceforge/business-kit/sheet';

export function NavigationIcon({ name }: { readonly name?: string | undefined }) {
  const paths: Readonly<Record<string, string>> = {
    smartphone: 'M8 2h8v20H8z M11 18h2', folder: 'M2 6h8l2 3h10l-3 11H2z M2 6V4h8l2 2',
    activity: 'M2 12h5l3-8 4 16 3-8h5', code: 'm8 5-6 7 6 7 M16 5l6 7-6 7',
    workflow: 'M3 3h6v6H3z M15 15h6v6h-6z M6 9v9h9 M15 3h6v6h-6z M9 6h6',
    terminal: 'm3 5 6 7-6 7 M12 19h9', sparkles: 'm12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3z',
    scan: 'M3 8V3h5 M16 3h5v5 M3 16v5h5 M16 21h5v-5 M14 14l4 4 M8 11a4 4 0 1 0 8 0a4 4 0 1 0-8 0',
    'list-checks': 'm2 6 2 2 4-4 M11 6h11 m-20 8 2 2 4-4 M11 14h11 M11 21h11',
    store: 'M3 9h18v13H3z M2 9l3-7h14l3 7 M9 22v-8h6v8', 'settings-2': 'M3 6h18 M3 18h18 M8 3v6 M16 15v6',
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="size-4 shrink-0" aria-hidden="true">
    <path d={paths[name ?? ''] ?? 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z'} strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

export function ShellNavigationLinks({ state, compact, navigate, children, drawer = false }: {
  readonly state: ShellState;
  readonly compact: boolean;
  readonly navigate: (route: string) => void;
  readonly children?: ReactNode;
  readonly drawer?: boolean;
}) {
  const pages = state.pages.filter((page) => !page.navigation?.hidden);
  const groups = [...new Set(pages.map((page) => page.navigation?.group ?? '插件'))];
  return <nav aria-label="工作区导航" className={`min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto pb-3.5 [scrollbar-width:thin] ${drawer ? 'pt-2' : 'pt-2.5'} ${compact ? 'px-2' : 'px-2.5'}`}>
    {groups.map((group) => <div key={group}>
      <h2 className={`m-0 px-2.5 pb-[7px] pt-1.5 text-[13px] font-semibold tracking-[0.06em] text-faint ${compact ? 'sr-only' : ''}`}>{group}</h2>
      <div className="space-y-px">{pages.filter((page) => (page.navigation?.group ?? '插件') === group).map((page) =>
        <button type="button" key={page.id} title={page.title} aria-current={normalizeRoute(page.route) === state.route ? 'page' : undefined}
          onClick={() => navigate(page.route)} className={`flex h-[34px] min-h-[34px] min-w-0 w-full items-center gap-2.5 rounded-md text-left text-[14px] ${compact ? 'justify-center px-0' : 'px-2.5'} ${normalizeRoute(page.route) === state.route ? 'bg-accent font-semibold text-primary [&>svg]:text-primary' : 'font-medium text-body hover:bg-surface-hover hover:text-foreground [&>svg]:text-faint'}`}>
          <NavigationIcon name={page.navigation?.icon} /><span className={compact ? 'sr-only' : 'min-w-0 truncate'}>{page.title}</span>
        </button>)}</div>
    </div>)}
    {children}
  </nav>;
}

export function ShellNavigation({ state, compact, connection, navigate, children, hidden = false }: {
  readonly state: ShellState;
  readonly compact: boolean;
  readonly connection: ShellConnection;
  readonly navigate: (route: string) => void;
  readonly children?: ReactNode;
  readonly hidden?: boolean;
}) {
  return <aside id="workspace-sidebar" hidden={hidden} inert={hidden} aria-label="主导航区域" className={`row-span-3 min-h-0 min-w-0 flex-col border-r border-[#E6EAF3] bg-white ${hidden ? 'hidden' : 'flex'}`}>
    <button type="button" aria-label="设备工坊首页" onClick={() => navigate('/')} className={`flex min-h-[58px] shrink-0 items-center gap-3 ${compact ? 'justify-center px-2' : 'px-4'}`}>
      <span className="flex size-[30px] shrink-0 items-center justify-center rounded-[7px] bg-[#6C4CF5] text-base font-bold text-white" aria-hidden="true">F</span>
      {!compact && <span className="min-w-0 text-left"><span className="block text-sm font-semibold tracking-wide text-[#222631]">FORGE</span><span className="block truncate text-xs text-[#8790A2]">设备工坊 DeviceForge</span></span>}
    </button>
    <div className={`flex min-w-0 shrink-0 items-center gap-2 border-b border-[#E6EAF3] pb-3 text-xs text-[#8790A2] ${compact ? 'justify-center px-2' : 'px-4'}`}>
      <span className={`size-1.5 shrink-0 rounded-full ${connection.state === 'connected' ? 'bg-emerald-500' : connection.state === 'failed' ? 'bg-red-500' : 'bg-slate-300'}`} aria-hidden="true" />
      {!compact && <><span className="shrink-0">本机服务</span><span title={connection.error ?? undefined} className={`ml-auto min-w-0 truncate ${connection.state === 'connected' ? 'text-emerald-600' : ''}`}>{connection.text}</span></>}
      {compact && <span className="sr-only">{connection.text}</span>}
    </div>
    <ShellNavigationLinks state={state} compact={compact} navigate={navigate}>{children}</ShellNavigationLinks>
    <div className={`flex min-h-11 shrink-0 items-center gap-0.5 border-t border-[#E6EAF3] px-2.5 text-[#6C7688] ${compact ? 'justify-center' : ''}`}>
      <button type="button" aria-label="设置" title="设置" onClick={() => navigate('/settings')} className="flex size-[30px] shrink-0 items-center justify-center rounded-md hover:bg-surface-hover hover:text-foreground"><NavigationIcon name="settings-2" /></button>
      {!compact && <span className="ml-auto font-mono text-[12px] text-ghost">v0.1.0</span>}
    </div>
  </aside>;
}

export function ShellHeader({ state, compact, focused, reduced, connection, onCollapse, onFocus, onReduced, onRefresh, navigate, children, mobile = false }: {
  readonly state: ShellState;
  readonly compact: boolean;
  readonly focused: boolean;
  readonly reduced: boolean;
  readonly connection: ShellConnection;
  readonly onCollapse: () => void;
  readonly onFocus: () => void;
  readonly onReduced: () => void;
  readonly onRefresh: () => void;
  readonly navigate: (route: string) => void;
  readonly children?: ReactNode;
  readonly mobile?: boolean;
}) {
  const navigationTrigger = <button type="button" aria-label={mobile ? '打开导航' : compact ? '展开侧边导航' : '折叠侧边导航'}
    {...(!mobile ? { onClick: onCollapse, 'aria-controls': 'workspace-sidebar', 'aria-expanded': !compact } : {})}
    className="flex size-7 shrink-0 items-center justify-center rounded text-[#596479] hover:bg-[#F5F6FB] @max-[768px]/default-shell:size-11">
    <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d={mobile ? 'M3 6h18 M3 12h18 M3 18h18' : 'M3 4h18v16H3z M8 4v16 M14 9l-3 3 3 3'} /></svg>
  </button>;
  return <header className="col-start-2 flex min-h-[54px] min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-[#E6EAF3] bg-white px-4 py-1.5 @max-[768px]/default-shell:min-h-[60px] @max-[768px]/default-shell:gap-1.5 @max-[768px]/default-shell:px-3 @max-[768px]/default-shell:py-2">
    <div className="flex min-w-0 flex-1 items-center gap-3 @max-[768px]/default-shell:gap-1.5">
      {mobile ? <SheetTrigger asChild>{navigationTrigger}</SheetTrigger> : navigationTrigger}
      <nav aria-label="面包屑" className="flex min-w-0 items-center gap-2 text-xs">
        <span className="shrink-0 text-[#8790A2] @max-[768px]/default-shell:hidden">{state.current?.page.navigation?.group ?? '工作台'}</span>
        <span className="text-[#BAC0CC] @max-[768px]/default-shell:hidden" aria-hidden="true">›</span><span aria-current="page" className="min-w-0 truncate font-medium text-[#222631] @max-[768px]/default-shell:max-w-[92px]">{state.current?.page.title ?? '工作区'}</span>
      </nav>
      {children}
    </div>
    <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2 text-xs text-[#596479] @max-[768px]/default-shell:gap-px @max-[768px]/default-shell:[&>button]:min-h-11 @max-[768px]/default-shell:[&>button]:min-w-11">
      {!compact && !mobile && <span aria-hidden="true" className="flex h-[30px] w-[232px] max-w-full min-w-0 items-center gap-2 rounded-[7px] border border-[#E6EAF3] bg-white pl-2.5 pr-1.5 text-xs text-[#8790A2]">
        <span className="min-w-0 truncate">搜索或运行命令</span>
        <kbd className="ml-auto shrink-0 rounded bg-[#F5F6FB] px-[5px] py-px font-mono text-[12px] font-medium leading-[1.4]">Ctrl K</kbd>
      </span>}
      <span role="status" title={connection.error ?? connection.text} className="flex min-w-0 items-center gap-1.5 @max-[768px]/default-shell:w-2 @max-[768px]/default-shell:gap-0">
        <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${connection.state === 'connected' ? 'bg-emerald-500' : connection.state === 'failed' ? 'bg-red-500' : 'bg-slate-300'}`} />
        <span className="truncate @max-[768px]/default-shell:sr-only">{connection.text}</span>
      </span>
      <button type="button" onClick={onFocus} aria-pressed={focused} className="rounded px-2 py-1.5 hover:bg-[#F5F6FB]">{focused ? '退出专注' : '专注'}</button>
      <button type="button" onClick={onRefresh} aria-label="重新连接服务器" title="重新连接服务器" className="flex size-7 items-center justify-center rounded hover:bg-[#F5F6FB]">
        <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M20 6v6h-6 M20 12a8 8 0 1 0-2 5 M20 6l-3-2" /></svg>
      </button>
      <MoreSettings reduced={reduced} onReduced={onReduced} onRefresh={onRefresh} navigate={navigate} />
    </div>
  </header>;
}

export function ShellStatus({ state, connection, facts = { endpoint: waiting<string>(), plugins: waiting<number>() } }: {
  readonly state: ShellState; readonly connection: ShellConnection; readonly facts?: ShellFacts;
}) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return <footer aria-label="运行状态" className="col-span-2 flex min-h-[26px] min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-[#E6EAF3] bg-white px-3 py-1 font-mono text-[12px] text-[#8790A2]">
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <span>{connection.text}</span>
      {facts.endpoint.value && <span className="max-w-64 truncate font-mono" title={facts.endpoint.error ?? facts.endpoint.value}>
        {new URL(facts.endpoint.value).host}{facts.endpoint.state !== 'confirmed' ? '（旧观测）' : ''}
      </span>}
      <span title={facts.plugins.error ?? undefined}>
        {facts.plugins.value === null ? '插件状态未确认' : facts.plugins.state === 'confirmed'
          ? `插件 ${facts.plugins.value} 已加载` : `插件 ${facts.plugins.value}（旧观测）`}
      </span>
      <span>页面 {state.pages.length}</span>
    </div>
    <div className="flex min-w-0 items-center gap-3">{connection.logId && <span className="min-w-0 max-w-80 truncate font-mono" title={connection.logId}>日志 {connection.logId}</span>}<time className="shrink-0 font-mono">{new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(now)}</time></div>
  </footer>;
}
