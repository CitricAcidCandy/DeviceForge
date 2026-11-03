import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { ShellState } from './controller.ts';
import type { ShellConnection } from './connection.ts';
import type { ShellFacts } from './facts-rules.ts';
import { waiting } from './facts-rules.ts';
import { normalizeRoute } from './controller.ts';

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

export function ShellNavigation({ state, compact, connection, navigate, children, hidden = false }: {
  readonly state: ShellState;
  readonly compact: boolean;
  readonly connection: ShellConnection;
  readonly navigate: (route: string) => void;
  readonly children?: ReactNode;
  readonly hidden?: boolean;
}) {
  const pages = state.pages.filter((page) => !page.navigation?.hidden);
  const groups = [...new Set(pages.map((page) => page.navigation?.group ?? '插件'))];
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
    <nav aria-label="工作区导航" className={`min-h-0 min-w-0 flex-1 space-y-5 overflow-y-auto py-4 ${compact ? 'px-2' : 'px-3'}`}>
      {groups.map((group) => <div key={group}>
        <h2 className={`mb-1 px-2 text-xs text-[#8790A2] ${compact ? 'sr-only' : ''}`}>{group}</h2>
        <div className="space-y-0.5">{pages.filter((page) => (page.navigation?.group ?? '插件') === group).map((page) =>
          <button type="button" key={page.id} title={page.title} aria-current={normalizeRoute(page.route) === state.route ? 'page' : undefined}
            onClick={() => navigate(page.route)} className={`flex min-h-9 min-w-0 w-full items-center gap-2.5 rounded-md text-left text-xs ${compact ? 'justify-center px-0' : 'px-2'} ${normalizeRoute(page.route) === state.route ? 'bg-[#F0EBFF] font-semibold text-[#6C4CF5]' : 'text-[#596479] hover:bg-[#F7F8FC]'}`}>
            <NavigationIcon name={page.navigation?.icon} /><span className={compact ? 'sr-only' : 'min-w-0 truncate'}>{page.title}</span>
          </button>)}</div>
      </div>)}
      {children}
    </nav>
    <div className={`flex min-h-11 shrink-0 items-center border-t border-[#E6EAF3] px-4 text-[10px] text-[#8790A2] ${compact ? 'justify-center' : 'justify-between'}`}>
      <button type="button" aria-label="设置" title="设置" onClick={() => navigate('/settings')}><NavigationIcon name="settings-2" /></button>
      {!compact && <span className="font-mono">v0.1.0</span>}
    </div>
  </aside>;
}

export function ShellHeader({ state, compact, focused, reduced, connection, onCollapse, onFocus, onReduced, onRefresh, navigate, children }: {
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
}) {
  const menu = (route: string, element: HTMLButtonElement) => {
    element.closest('details')?.removeAttribute('open');
    navigate(route);
  };
  return <header className="col-start-2 flex min-h-[54px] min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-[#E6EAF3] bg-white px-4 py-1.5">
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <button type="button" onClick={onCollapse} aria-label={compact ? '展开侧边导航' : '折叠侧边导航'} aria-controls="workspace-sidebar" aria-expanded={!compact} className="flex size-7 shrink-0 items-center justify-center rounded text-[#596479] hover:bg-[#F5F6FB]">
        <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M3 4h18v16H3z M8 4v16 M14 9l-3 3 3 3" /></svg>
      </button>
      <nav aria-label="面包屑" className="flex min-w-0 items-center gap-2 text-xs">
        <span className="shrink-0 text-[#8790A2]">{state.current?.page.navigation?.group ?? '工作台'}</span>
        <span className="text-[#BAC0CC]" aria-hidden="true">›</span><span aria-current="page" className="min-w-0 truncate font-medium text-[#222631]">{state.current?.page.title ?? '工作区'}</span>
      </nav>
      {children}
    </div>
    <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2 text-xs text-[#596479]">
      {!compact && <span aria-hidden="true" className="flex h-[30px] w-[232px] max-w-full min-w-0 items-center gap-2 rounded-[7px] border border-[#E6EAF3] bg-white pl-2.5 pr-1.5 text-xs text-[#8790A2]">
        <span className="min-w-0 truncate">搜索或运行命令</span>
        <kbd className="ml-auto shrink-0 rounded bg-[#F5F6FB] px-[5px] py-px font-mono text-[12px] font-medium leading-[1.4]">Ctrl K</kbd>
      </span>}
      <span role="status" title={connection.error ?? undefined} className="flex min-w-0 items-center gap-1.5">
        <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${connection.state === 'connected' ? 'bg-emerald-500' : connection.state === 'failed' ? 'bg-red-500' : 'bg-slate-300'}`} />
        <span className="truncate">{connection.text}</span>
      </span>
      <button type="button" onClick={onFocus} aria-pressed={focused} className="rounded px-2 py-1.5 hover:bg-[#F5F6FB]">{focused ? '退出专注' : '专注'}</button>
      <button type="button" onClick={onRefresh} aria-label="重新连接服务器" title="重新连接服务器" className="flex size-7 items-center justify-center rounded hover:bg-[#F5F6FB]">
        <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M20 6v6h-6 M20 12a8 8 0 1 0-2 5 M20 6l-3-2" /></svg>
      </button>
      <details className="relative" onKeyDown={(event) => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); } }}>
        <summary aria-label="更多设置" className="flex size-7 cursor-pointer list-none items-center justify-center rounded text-lg hover:bg-[#F5F6FB]">⋯</summary>
        <div className="absolute right-0 top-8 z-[300] w-48 rounded-lg border border-[#E6EAF3] bg-white p-1 shadow-lg">
          <button type="button" onClick={onRefresh} className="w-full rounded px-3 py-2 text-left hover:bg-[#F5F6FB]">重新连接服务器</button>
          <button type="button" role="menuitemcheckbox" aria-checked={reduced} onClick={onReduced} className="w-full rounded px-3 py-2 text-left hover:bg-[#F5F6FB]">{reduced ? '✓ ' : ''}减少动态效果</button>
          <button type="button" onClick={(event) => menu('/settings', event.currentTarget)} className="w-full rounded px-3 py-2 text-left hover:bg-[#F5F6FB]">主题与设置</button>
          <button type="button" onClick={(event) => menu('/marketplace', event.currentTarget)} className="w-full rounded px-3 py-2 text-left hover:bg-[#F5F6FB]">管理插件</button>
        </div>
      </details>
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
  return <footer aria-label="运行状态" className="col-span-2 flex min-h-[26px] min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-[#E6EAF3] bg-white px-3 py-1 text-[10px] text-[#8790A2]">
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
