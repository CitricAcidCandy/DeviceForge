import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, MoreHorizontal, Pause, Play, Power, RefreshCw } from 'lucide-react';
import { Button } from '../../components/Button/index.tsx';
import { JsonResult } from '../../components/index.ts';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/DropdownMenu/index.tsx';
import { useAction, useSnapshot } from '../../app/product/hooks.ts';
import type { ProductServices } from '../../app/product/services.ts';
import type { SessionInputState } from '../../features/interactive-sessions/index.ts';
import { TerminalViewport } from './TerminalViewport.tsx';
import type { TerminalViewportHandle } from './TerminalViewport.tsx';
import { useTerminalInput } from './use-terminal-input.ts';
import { TerminalHistory } from './TerminalHistory.tsx';

// 会话状态文案只说事实：opening 是进程还没起来，不等于「运行中」。
const stateText: Record<string, string> = {
  opening: '启动中',
  running: '运行中',
  stopping: '关闭中',
  finished: '已结束',
};
const inputText: Record<SessionInputState, string> = {
  writable: '可输入',
  unknown: '输入未确认',
  eof_pending: '正在关闭输入',
  eof: '输入已关闭',
  uncertain: '输入待确认',
};
const cleanupText: Record<string, string> = {
  complete: '清理完成',
  failed: '清理失败',
  unconfirmed: '清理未确认',
};
interface TerminalProfile {
  readonly name: string;
  readonly detail: string;
}

/** 从插件配置里读终端档案：profiles 是「名字 → 启动程序」映射，不是会话定义。 */
function readProfiles(values: unknown): TerminalProfile[] {
  if (typeof values !== 'object' || values === null) return [];
  const profiles = (values as { profiles?: unknown }).profiles;
  if (typeof profiles !== 'object' || profiles === null) return [];
  return Object.entries(profiles as Record<string, unknown>).map(([name, raw]) => {
    const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    const executable = typeof record.executable === 'string' ? record.executable : '';
    const args = Array.isArray(record.args)
      ? record.args.filter((item): item is string => typeof item === 'string')
      : [];
    return { name, detail: [executable, ...args].filter(Boolean).join(' ') };
  });
}

const shortId = (id: string): string => id.slice(0, 8);
const dotTone = (status: string | undefined): string =>
  status === 'running'
    ? 'bg-[color:var(--success)]'
    : status === 'opening' || status === 'stopping'
      ? 'bg-[color:var(--warning)]'
      : 'bg-[color:var(--media-muted)]';

export function TerminalPage({ services }: { services: ProductServices }) {
  const terminal = services.sessions;
  const snapshot = useSnapshot(terminal);
  const action = useAction();
  const reader = useAction();
  const [profiles, setProfiles] = useState<TerminalProfile[]>([]);
  const [profilesError, setProfilesError] = useState<string | null>(null);
  const [profile, setProfile] = useState<string | null>(null);
  const [raw, setRaw] = useState(false);
  const viewport = useRef<TerminalViewportHandle | null>(null);
  const session = snapshot.session;
  const input = useTerminalInput(terminal, session?.id);
  const terminalAvailable =
    snapshot.definitions?.sessions.some((item) => item.id === 'plugin.terminal.open') ?? false;
  // 路由隐藏时保留当前会话；刷新前的其他终端通过真实记录列表显式回收，不自动接回输入。
  const live = !!session && session.status !== 'finished';
  const writable =
    !!session &&
    session.status !== 'finished' &&
    session.status !== 'stopping' &&
    snapshot.inputState === 'writable' &&
    !input.error;

  const loadProfiles = (signal: AbortSignal) =>
    services.pluginConfigurations
      .get({ kind: 'server', id: 'terminal' }, signal)
      .then((view) => {
        const next = readProfiles(view.values);
        setProfiles(next);
        setProfilesError(next.length ? null : '终端配置里还没有档案');
        setProfile((current) =>
          next.some((item) => item.name === current) ? current : (next[0]?.name ?? null),
        );
        return next;
      })
      .catch((error: unknown) => {
        setProfiles([]);
        setProfilesError(error instanceof Error ? error.message : '读取终端配置失败');
        return [];
      });

  useEffect(() => {
    void action.run(
      async (signal) => {
        // 目录与档案一起读：只有插件在册，档案才有意义。
        await terminal.refreshDefinitions(signal);
        return loadProfiles(signal);
      },
      { quiet: true },
    );
    // 只在进入页面时读一次；后续由「刷新目录」显式重读。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal]);

  // 关闭收据可能只有Stopping，继续读取到真实终态才能确认清理和允许新建。
  useEffect(() => {
    if (!session) return;
    if (session.status === 'finished') return;
    void reader.run((signal) => terminal.pollOutput({}, signal), { quiet: true });
    return () => reader.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, session?.status, terminal]);

  const openWith = (name: string) => {
    if (!name || live) return;
    setProfile(name);
    void action.run(
      async (signal) => {
        // 服务端只留 8 条记录，且本页不接回旧会话：先把已结束的那条清掉，
        // 否则连着开几次就会撞上「会话容量已满」而页面里没有任何入口可清。
        if (session?.status === 'finished') {
          try {
            await terminal.remove(signal);
          } catch {
            // 记录可能已被别处删除，清不掉也不该挡住开新会话。
          }
        }
        return terminal.openPtyTerminal(
          name,
          viewport.current?.size() ?? { cols: 120, rows: 30 },
          signal,
        );
      },
      { success: null },
    );
  };

  return (
    <section
      className="product-page terminal-page flex min-h-[560px] flex-1 flex-col gap-3"
      data-product-page="terminal"
      aria-label="终端"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="text-[24px] font-semibold text-[color:var(--text-strong)]">终端</h1>
          <span className="flex items-center gap-1.5 font-mono text-[12px] text-[color:var(--text-faint)]">
            <span
              className={`size-1.5 rounded-full ${dotTone(session?.status)}`}
              aria-hidden="true"
            />
            {session ? (stateText[session.status] ?? session.status) : '未打开'}
            {profile && (
              <>
                <span aria-hidden="true" className="text-[color:var(--text-ghost)]">
                  ·
                </span>
                <span className="text-[color:var(--text-ghost)]">{profile}</span>
              </>
            )}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-stretch">
            <Button
              size="sm"
              className="rounded-r-none text-[13px]"
              disabled={!terminalAvailable || !profile || live || action.pending}
              title={live ? '先关闭当前会话' : '用当前档案开新会话'}
              onClick={() => profile && openWith(profile)}
            >
              新会话
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  className="rounded-l-none border-l border-black/15 px-2"
                  disabled={!terminalAvailable || live || action.pending}
                  aria-label="选择终端档案"
                  title="选择终端档案"
                >
                  <ChevronDown size={13} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-72">
                <DropdownMenuLabel className="text-[12px] font-normal text-[color:var(--text-faint)]">
                  在档案中新建会话
                </DropdownMenuLabel>
                {profiles.length === 0 ? (
                  <DropdownMenuItem disabled>未读取到终端档案</DropdownMenuItem>
                ) : (
                  profiles.map((item) => (
                    <DropdownMenuItem key={item.name} onSelect={() => openWith(item.name)}>
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate font-mono text-[13px] text-[color:var(--text-strong)]">
                          {item.name}
                        </span>
                        {item.detail && (
                          <span className="truncate font-mono text-[12px] text-[color:var(--text-faint)]">
                            {item.detail}
                          </span>
                        )}
                      </span>
                      {profile === item.name && <Check size={13} className="text-primary" />}
                    </DropdownMenuItem>
                  ))
                )}
                {profilesError && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem disabled className="text-[12px]">
                      <span className="line-clamp-2 text-left">{profilesError}</span>
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="text-[13px]"
            disabled={action.pending}
            onClick={() =>
              void action.run(
                async (signal) => {
                  await terminal.refreshDefinitions(signal);
                  return loadProfiles(signal);
                },
                { pending: '正在刷新终端目录…', success: '终端目录已刷新' },
              )
            }
          >
            <RefreshCw size={13} aria-hidden="true" />
            刷新目录
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="text-[13px] text-[color:var(--destructive)]"
            disabled={!session || session.status === 'finished'}
            onClick={() => void action.run((signal) => terminal.cancel(signal), { success: null })}
          >
            <Power size={13} aria-hidden="true" />
            关闭会话
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-white/10 bg-[color:var(--media-background)]">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-white/10 bg-white/[0.03] px-3.5 font-mono text-[12px] text-[color:var(--media-muted)]">
          <span
            className={`size-1.5 rounded-full ${dotTone(session?.status)}`}
            aria-hidden="true"
          />
          <span className="shrink-0 text-[13px] text-[color:var(--media-foreground)]">
            {session ? shortId(session.id) : '未打开'}
          </span>
          {session && (
            <>
              <span aria-hidden="true">·</span>
              <span className="min-w-0 truncate">{session.operation}</span>
              <span aria-hidden="true">·</span>
              <span className="min-w-0 truncate">{profile ?? '—'}</span>
            </>
          )}
          <span className="min-w-0 flex-1" />
          <span className="hidden shrink-0 sm:inline">交互终端</span>
          {session && (
            <span className="hidden shrink-0 opacity-70 md:inline">游标 {snapshot.cursor}</span>
          )}
          <button
            type="button"
            aria-label={reader.pending ? '暂停读取输出' : '继续读取输出'}
            title={reader.pending ? '暂停读取（不会停止服务器会话）' : '继续读取输出'}
            disabled={!session}
            onClick={() =>
              reader.pending
                ? reader.cancel()
                : void reader.run((signal) => terminal.pollOutput({}, signal), {
                    quiet: true,
                  })
            }
            className="grid size-6 shrink-0 place-items-center rounded-md text-[color:var(--media-muted)] hover:bg-white/10 hover:text-[color:var(--media-foreground)] disabled:opacity-40"
          >
            {reader.pending ? <Pause size={14} /> : <Play size={14} />}
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="更多会话操作"
                className="grid size-6 shrink-0 place-items-center rounded-md text-[color:var(--media-muted)] hover:bg-white/10 hover:text-[color:var(--media-foreground)]"
              >
                <MoreHorizontal size={15} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem
                disabled={!session}
                onSelect={() =>
                  void action.run((signal) => terminal.query(signal), { quiet: true })
                }
              >
                重查会话状态
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!session || session.status !== 'finished'}
                onSelect={() =>
                  void action.run((signal) => terminal.remove(signal), { success: null })
                }
              >
                删除已结束记录
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={snapshot.chunks.length === 0}
                onSelect={() => viewport.current?.clear()}
              >
                清空页面输出
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!session} onSelect={() => setRaw((value) => !value)}>
                {raw ? '收起原始会话记录' : '查看原始会话记录'}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <TerminalViewport
          key={session?.id ?? 'empty'}
          handle={viewport}
          chunks={snapshot.chunks}
          writable={writable}
          onData={input.input}
          onResize={(size) => {
            if (writable) input.resize(size);
          }}
        />
        {input.error && (
          <p role="alert" className="px-4 py-2 text-sm text-red-300">
            {input.error}
          </p>
        )}

        {session?.status === 'finished' && (
          <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-t border-white/10 bg-white/[0.02] px-3.5 py-2 font-mono text-[12px] text-[color:var(--media-muted)]">
            <span>已结束</span>
            <span aria-hidden="true">·</span>
            <span>{cleanupText[session.completion?.cleanup ?? 'unconfirmed']}</span>
            {!!session.completion?.outcome?.artifacts.length && (
              <>
                <span aria-hidden="true">·</span>
                <span>{session.completion.outcome.artifacts.length} 个产物</span>
              </>
            )}
            {session.completion?.failure && (
              <span className="text-[color:color-mix(in_srgb,var(--destructive)_58%,white)]">
                {session.completion.failure.code}：{session.completion.failure.message}
              </span>
            )}
            {session.completion?.outcome?.error && (
              <span className="text-red-300">{session.completion.outcome.error}</span>
            )}
          </div>
        )}

        <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-white/10 bg-white/[0.03] px-3.5 py-2 text-[12px] text-[color:var(--media-muted)]">
          <span>{session ? inputText[snapshot.inputState] : '选择档案并打开新会话'}</span>
          <span>
            点击终端输入 · Tab 补全 · ↑↓ 历史 · Ctrl+C 中断 · Ctrl+Shift+C 复制 · 浏览器粘贴 /
            Ctrl+Shift+V
          </span>
          <button
            type="button"
            className="ml-auto underline underline-offset-2"
            onClick={() => viewport.current?.focus()}
            disabled={!writable}
          >
            聚焦终端
          </button>
        </div>
        <p className="border-t border-white/10 px-3.5 py-2 text-xs text-[color:var(--media-muted)]">
          切换功能页可继续保留；刷新或关闭页面将尝试结束当前会话。
        </p>
      </div>

      <TerminalHistory terminal={terminal} records={snapshot.records} currentId={session?.id} />

      {raw && session && (
        <div className="flex max-h-64 shrink-0 flex-col gap-2 overflow-auto rounded-xl border border-[color:var(--hairline)] bg-[color:var(--card)] p-3">
          <div className="flex items-center justify-between">
            <span className="text-[12px] text-[color:var(--text-muted)]">原始会话记录</span>
            <button
              type="button"
              onClick={() => setRaw(false)}
              className="text-[12px] text-[color:var(--text-faint)] hover:text-[color:var(--text-body)]"
            >
              收起
            </button>
          </div>
          <JsonResult value={session} />
        </div>
      )}
    </section>
  );
}
