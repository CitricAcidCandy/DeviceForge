import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ProductPlatformServices } from '../product/platform-services.ts';
import type { ShellHost } from './shell-host.ts';
import { SHELL_POINT } from './shell-host.ts';
import { recoveryFailure } from './recovery-state.ts';
import type { RecoveryFailure } from './recovery-state.ts';
import { copyText } from '../../shared/clipboard/index.ts';

const emptySources = Object.freeze([]);
export function PlatformRecoveryEntry({ expanded, onOpen }: { readonly expanded: boolean; readonly onOpen: () => void }) {
  return <button type="button" className="fixed bottom-10 right-20 z-[700] rounded-lg border border-[#E6EAF3] bg-white px-3 py-2 text-[11px] text-[#596479] shadow-sm"
    aria-expanded={expanded} onClick={onOpen}>平台恢复</button>;
}
export function PlatformRecovery({ services, shell }: { readonly services: ProductPlatformServices; readonly shell: ShellHost }) {
  const runtime = services.runtime;
  const state = useSyncExternalStore(shell.subscribe, shell.snapshot, shell.snapshot);
  const recovery = useSyncExternalStore(runtime.recovery.subscribe, runtime.recovery.snapshot, runtime.recovery.snapshot);
  const officialStore = useMemo(() => ({
    subscribe: (notify: () => void) => services.officialPlugins?.subscribe(notify) ?? (() => {}),
    snapshot: () => services.officialPlugins?.snapshot() ?? emptySources,
  }), [services]);
  const sources = useSyncExternalStore(officialStore.subscribe, officialStore.snapshot, officialStore.snapshot);
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<RecoveryFailure | null>(null);
  const [section, setSection] = useState<'shells' | 'connection' | 'plugins' | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<{ readonly logId: string; readonly message: string } | null>(null);
  const [address, setAddress] = useState(services.baseUrl);
  const [token, setToken] = useState('');
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    const release = runtime.host.extensions?.points?.subscribe(() => setRevision((value) => value + 1));
    return () => { void release?.(); };
  }, [runtime]);
  useEffect(() => { setDismissed(false); setError(null); setCopyFeedback(null); }, [state.state, state.error, state.errorLogId]);
  const choices = useMemo(() => runtime.host.extensions?.points?.list(SHELL_POINT)
    .filter((entry) => entry.state === 'active' && entry.mode === 'replace') ?? [], [runtime, revision, state]);
  const running = runtime.webPlugins.diagnosticSnapshot();
  const expanded = recovery.open || !state.active && !dismissed;
  const selected = choices.find((choice) => choice.id === state.requested);
  const official = choices.filter((choice) => choice.provider.pluginId === 'deviceforge_shell');
  const failure = error ?? (state.error ? { message: state.error, logId: state.errorLogId } : null);
  async function perform(id: string, work: (signal: AbortSignal) => Promise<unknown>) {
    if (pending) return;
    setPending(id); setError(null); setCopyFeedback(null);
    try { await work(runtime.host.signal); }
    catch (failure) {
      if (!runtime.host.signal.aborted) setError(recoveryFailure(failure, '平台操作未确认，请查询实际状态'));
    } finally { if (!runtime.host.signal.aborted) setPending(null); }
  }
  function selectShell(id: string) {
    setError(null); setCopyFeedback(null);
    try { runtime.host.extensions?.points?.select(SHELL_POINT, id); shell.retry(); }
    catch (failure) { setError(recoveryFailure(failure, '外壳选择未确认，请查询实际状态')); }
  }
  function retryShell() {
    setError(null); setCopyFeedback(null);
    try { shell.retry(); }
    catch (failure) { setError(recoveryFailure(failure, '外壳准备未确认，请查询实际状态')); }
  }
  async function copyFailureLogId() {
    const logId = failure?.logId;
    if (!logId) return;
    const copied = await copyText(logId);
    if (!runtime.host.signal.aborted) setCopyFeedback({ logId,
      message: copied ? '日志 ID 已复制' : '复制失败，请手动选择日志 ID' });
  }
  const panel = <section role="dialog" aria-modal="true" aria-labelledby="platform-recovery-title"
    className={`mx-auto flex w-full max-w-[688px] flex-col rounded-xl border border-[#E6EAF3] bg-white p-8 max-[760px]:p-6 ${section ? '' : 'min-h-[474px]'}`}>
    <h1 id="platform-recovery-title" className="text-xl font-semibold text-[#222631]">{state.active ? '平台恢复' : state.state === 'failed' ? '外壳暂时无法显示' : '工作区暂未显示'}</h1>
    {!section && <>
      <div className="mt-5 text-xs leading-4 text-[#596479]">
        <p>当前选择：<span className="break-all">{selected?.id ?? state.requested ?? '尚未选择外壳'}</span></p>
        <p>来源：<span className="break-all">{selected?.provider.pluginId ?? state.active?.pluginId ?? '来源暂不可用'}</span></p>
        {(official.length > 1 || choices.some((choice) => choice.provider.pluginId !== 'deviceforge_shell') || state.state === 'failed' && state.requested !== null) && <button type="button" className="mt-2 text-[#6C4CF5]" onClick={() => setSection('shells')}>选择其他外壳</button>}
      </div>
      <p className="mt-7 flex min-h-[82px] items-center rounded-lg bg-[#FFF4E3] px-4 py-3 text-xs leading-5 text-[#A65D0D]">
        {state.state === 'preparing' ? '所选外壳正在准备，等待实际挂载结果。' : '业务布局保留，已停用的业务插件保持停用。选择外壳只恢复界面显示，不重放任务或修改。'}
      </p>
      <div className="mt-8 flex flex-wrap items-center gap-6">
        <button type="button" disabled={pending !== null || official.length === 0} className="min-h-[42px] w-60 rounded-lg bg-[#6C4CF5] px-5 py-2 text-xs text-white disabled:opacity-50"
          title={official.length === 0 ? '官方外壳当前不可用，可从管理插件检查启用状态' : '显式选择官方外壳，不自动启用业务插件'} onClick={() => {
            const choice = official.length === 1 ? official[0] : undefined;
            if (choice) selectShell(choice.id); else setSection('shells');
          }}>选择官方外壳</button>
        <button type="button" className="text-xs text-[#6C4CF5]" onClick={() => setSection('plugins')}>管理插件</button>
        <button type="button" className="text-xs text-[#6C4CF5]" onClick={() => setSection('connection')}>检查连接</button>
      </div>
    </>}
    {section && <div className="mt-5">
      <button type="button" className="text-xs text-[#6C4CF5]" onClick={() => setSection(null)}>返回恢复概览</button>
      {section === 'shells' && <section aria-label="外壳选择" className="mt-5">
        <h2 className="text-sm font-semibold">选择工作区外壳</h2>
        <p className="mt-2 text-xs leading-5 text-[#596479]">成功显示新外壳后才替换当前内容，失败时保留原外壳。</p>
        <div className="mt-3 space-y-2">{choices.length ? choices.map((choice) => <button type="button" key={choice.id}
          className="w-full rounded-xl border border-[#E6EAF3] px-4 py-3 text-left text-xs disabled:opacity-50" disabled={pending !== null}
          onClick={() => selectShell(choice.id)}>
          <span className="font-semibold">{choice.provider.pluginId}</span><span className="ml-2 text-[#596479]">{choice.id === state.active?.id ? '当前显示' : choice.selected ? '所选提供者' : '使用此外壳'}</span>
        </button>) : <p className="rounded-lg border border-dashed border-[#E6EAF3] p-4 text-xs text-[#596479]">当前没有可用外壳，请启用提供外壳的插件。</p>}</div>
        {state.requested && state.state === 'failed' && <button type="button" className="mt-3 rounded-lg bg-[#6C4CF5] px-4 py-2 text-xs text-white" onClick={retryShell}>重新准备所选外壳</button>}
      </section>}
      {section === 'connection' && <section aria-label="连接管理" className="mt-5">
        <h2 className="text-sm font-semibold">服务连接</h2>
        <p className="mt-2 break-all font-mono text-[11px] text-[#596479]">{services.baseUrl}</p>
        {services.connection ? <form className="mt-3 space-y-3" onSubmit={(event) => {
          event.preventDefault();
          const connection = services.connection;
          if (connection) void perform('connection', (signal) => connection.reconnect(address, token, signal));
        }}>
          <label className="block text-xs text-[#596479]">服务地址<input value={address} onChange={(event) => setAddress(event.target.value)} className="mt-1.5 w-full rounded-lg border border-[#E6EAF3] px-3 py-2 text-xs text-[#222631]" /></label>
          <label className="block text-xs text-[#596479]">可选令牌<input type="password" value={token} autoComplete="off" onChange={(event) => setToken(event.target.value)} className="mt-1.5 w-full rounded-lg border border-[#E6EAF3] px-3 py-2 text-xs text-[#222631]" /></label>
          <button type="submit" disabled={pending !== null} className="rounded-lg border border-[#E6EAF3] px-4 py-2 text-xs disabled:opacity-50">核对并切换连接</button>
        </form> : <p className="mt-3 text-xs leading-6 text-[#596479]">当前宿主未提供连接切换能力，不能在此确认服务器已连接。</p>}
      </section>}
      {section === 'plugins' && <section aria-label="插件管理" className="mt-5">
        <h2 className="text-sm font-semibold">随附插件与运行实例</h2>
        <div className="mt-3 max-h-60 space-y-2 overflow-y-auto">{sources.map((source) => <div key={source.id} className="flex items-center justify-between gap-4 rounded-xl border border-[#E6EAF3] px-4 py-3">
          <div className="min-w-0"><p className="text-xs font-semibold">{source.title}<span className="ml-2 font-normal text-[#596479]">{source.phase === 'loaded' ? '已启用' : source.phase === 'disabled' ? '已停用' : source.phase === 'failed' ? '未完成' : source.phase === 'loading' ? '启用中' : source.phase === 'external' ? '独立安装' : '待启用'}</span></p>
            <p className="mt-1 truncate font-mono text-[10px] text-[#8790A2]">{source.id}</p>{source.error && <p className="mt-1 text-xs text-[#A65D0D]">{source.error}</p>}</div>
          {source.phase !== 'external' && <button type="button" disabled={pending !== null} className="shrink-0 rounded-lg border border-[#E6EAF3] px-3 py-2 text-xs disabled:opacity-50"
            onClick={() => {
              const plugins = services.officialPlugins;
              if (plugins) void perform(source.id, (signal) => plugins.setEnabled(source.id, source.phase !== 'loaded', signal));
            }}>{source.phase === 'loaded' ? '停用' : '启用'}</button>}
        </div>)}
          {running.filter((item) => !sources.some((source) => source.id === item.id)).map((item) => <div key={item.id} className="flex items-center justify-between rounded-xl border border-[#E6EAF3] px-4 py-3 text-xs">
            <span>{item.id} · {item.state === 'loaded' ? '已启用' : '加载中'}</span><button type="button" disabled={pending !== null} className="rounded-lg border border-[#E6EAF3] px-3 py-2 disabled:opacity-50"
              onClick={() => void perform(item.id, () => runtime.webPlugins.unload(item.id))}>停用</button></div>)}
        </div>
        {sources.length === 0 && running.length === 0 && <p className="mt-3 text-xs text-[#596479]">当前没有可管理的插件记录。</p>}
      </section>}
    </div>}
    <details className="mt-10 text-xs text-[#596479]">
      <summary aria-label="查看本次失败详情" className="cursor-pointer">查看失败原因 / 复制日志 ID</summary>
      <p role={failure ? 'alert' : undefined} className="mt-3 break-words leading-6">{failure?.message ?? '当前没有已确认的失败原因。'}</p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <span>本次日志 ID：</span><code aria-label="本次失败日志 ID" className="select-text break-all font-mono">{failure?.logId ?? '未知（本次失败未提供）'}</code>
        <button type="button" aria-label="复制本次失败日志 ID" disabled={!failure?.logId} className="rounded-lg border border-[#E6EAF3] px-3 py-1.5 text-[#6C4CF5] disabled:opacity-50" onClick={() => { void copyFailureLogId(); }}>复制日志 ID</button>
      </div>
      {copyFeedback && copyFeedback.logId === failure?.logId && <p role="status" className="mt-2">{copyFeedback.message}</p>}
    </details>
    <p className="mt-3 text-xs leading-5 text-[#596479]">收起面板后，右下角“平台恢复”入口仍在。</p>
    {state.cleanupErrors.length > 0 && <details className="mt-5 text-xs text-[#A65D0D]"><summary>历史资源回收记录 · {state.cleanupErrors.length}</summary><pre className="mt-2 whitespace-pre-wrap">{state.cleanupErrors.join('\n')}</pre></details>}
    <div className="mt-auto flex justify-end pt-7"><button type="button" aria-label="收起平台恢复" className="text-xs text-[#6C4CF5]" onClick={() => { setDismissed(true); runtime.recovery.close(); }}>收起面板</button></div>
  </section>;
  return <>
    <PlatformRecoveryEntry expanded={expanded} onOpen={runtime.recovery.open} />
    {state.active ? expanded && <div className="fixed inset-0 z-[690] flex items-center justify-center overflow-y-auto bg-[#22263130] p-6">{panel}</div>
      : <div role="region" aria-label="平台恢复独立界面" className="fixed inset-0 z-[680] grid grid-rows-[56px_minmax(0,1fr)_48px] bg-[#F5F6FB] text-[#222631]">
        <header className="flex h-14 min-w-0 items-center justify-between gap-4 border-b border-[#E6EAF3] bg-white px-6">
          <p className="text-sm">DeviceForge <span className="mx-2">/</span> 平台恢复</p>
          <p className="text-[11px] text-[#596479]">{services.connection ? '内核可用 · 连接待核对' : '内核可用 · 连接切换未提供'}</p>
        </header>
        <main className="min-h-0 overflow-y-auto px-6 pb-8 pt-[92px] max-[760px]:py-8">{expanded && panel}</main>
        <footer className="flex h-12 min-w-0 items-center border-t border-[#E6EAF3] bg-white px-6 pr-40 text-[11px] text-[#596479]">
          <p className="truncate">{state.state === 'preparing' ? '正在准备界面，平台内核继续运行' : '界面来源不可用，平台内核继续运行'}</p>
        </footer>
      </div>}
  </>;
}
