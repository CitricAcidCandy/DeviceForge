import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, MoreHorizontal, Pause, Play, Power, RefreshCw, Terminal } from 'lucide-react';
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
import type { SessionChunkView, SessionInputState } from '../../features/interactive-sessions/index.ts';

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
// 页面只渲染最近这么多行；超出部分在顶部如实说明，不做静默截断。
const RENDER_LINES = 2000;

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

/**
 * 把原始输出块还原成带来源的行。旧实现把全部块 join 成一段文本，
 * stream 字段直接丢掉，标准错误只能和标准输出同色——这里保序拆分，
 * 跨块未结束的半行留到下一块拼接。
 */
function readLines(chunks: readonly SessionChunkView[]): { text: string; stderr: boolean }[] {
  const decoder = new TextDecoder();
  const lines: { text: string; stderr: boolean }[] = [];
  let pending = '';
  let pendingStderr = false;
  for (const chunk of chunks) {
    const text = decoder.decode(Uint8Array.from(chunk.bytes), { stream: true });
    const parts = (pending + text).split('\n');
    pending = parts.pop() ?? '';
    for (const part of parts) lines.push({ text: part, stderr: chunk.stream === 'stderr' });
    pendingStderr = chunk.stream === 'stderr';
  }
  if (pending) lines.push({ text: pending, stderr: pendingStderr });
  return lines;
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
  const [command, setCommand] = useState('');
  const [raw, setRaw] = useState(false);
  const output = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const session = snapshot.session;
  const terminalAvailable =
    snapshot.definitions?.sessions.some((item) => item.id === 'plugin.terminal.open') ?? false;
  // 一个页面只持有一个会话：不支持接回旧会话之前不并列多个，避免离开页面后留下看不见的孤儿进程。
  const live = !!session && session.status !== 'finished';
  const writable = !!session && session.status !== 'finished' && snapshot.inputState === 'writable';
  const lines = useMemo(() => readLines(snapshot.chunks), [snapshot.chunks]);
  const visible = lines.length > RENDER_LINES ? lines.slice(-RENDER_LINES) : lines;

  const loadProfiles = (signal: AbortSignal) =>
    services.pluginConfigurations
      .get({ kind: 'server', id: 'terminal' }, signal)
      .then((view) => {
        const next = readProfiles(view.values);
        setProfiles(next);
        setProfilesError(next.length ? null : '终端配置里还没有档案');
        setProfile((current) => current ?? next[0]?.name ?? null);
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

  // 会话进入运行态就持续拉输出；状态变化或离开页面时停止等待。
  useEffect(() => {
    if (!session) return;
    if (session.status !== 'opening' && session.status !== 'running') return;
    stick.current = true;
    void reader.run((signal) => terminal.pollOutput({ limit: 200 }, signal), { quiet: true });
    return () => reader.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, session?.status, terminal]);

  useEffect(() => {
    const node = output.current;
    if (node && stick.current) node.scrollTop = node.scrollHeight;
  }, [visible.length]);

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
        return terminal.openTerminal(name, signal);
      },
      { success: null },
    );
  };

  const send = () => {
    const value = command;
    if (!value.trim() || !writable) return;
    setCommand('');
    void action.run(
      (signal) => terminal.send([...new TextEncoder().encode(value + '\n')], signal),
      { quiet: true },
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
          <h1 className="text-[22px] font-semibold text-[color:var(--text-strong)]">终端</h1>
          <span className="flex items-center gap-1.5 font-mono text-[11px] text-[color:var(--text-faint)]">
            <span className={`size-1.5 rounded-full ${dotTone(session?.status)}`} aria-hidden="true" />
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
              className="rounded-r-none text-[12px]"
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
                <DropdownMenuLabel className="text-[11px] font-normal text-[color:var(--text-faint)]">
                  在档案中新建会话
                </DropdownMenuLabel>
                {profiles.length === 0 ? (
                  <DropdownMenuItem disabled>未读取到终端档案</DropdownMenuItem>
                ) : (
                  profiles.map((item) => (
                    <DropdownMenuItem key={item.name} onSelect={() => openWith(item.name)}>
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate font-mono text-[12px] text-[color:var(--text-strong)]">
                          {item.name}
                        </span>
                        {item.detail && (
                          <span className="truncate font-mono text-[11px] text-[color:var(--text-faint)]">
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
                    <DropdownMenuItem disabled className="text-[11px]">
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
            className="text-[12px]"
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
            className="text-[12px] text-[color:var(--destructive)]"
            disabled={!session || session.status === 'finished'}
            onClick={() => void action.run((signal) => terminal.cancel(signal), { success: null })}
          >
            <Power size={13} aria-hidden="true" />
            关闭会话
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-white/10 bg-[color:var(--media-background)]">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-white/10 bg-white/[0.03] px-3.5 font-mono text-[11px] text-[color:var(--media-muted)]">
          <span className={`size-1.5 rounded-full ${dotTone(session?.status)}`} aria-hidden="true" />
          <span className="shrink-0 text-[12px] text-[color:var(--media-foreground)]">
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
          <span className="hidden shrink-0 sm:inline">{lines.length} 行</span>
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
                : void reader.run((signal) => terminal.pollOutput({ limit: 200 }, signal), {
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
                onSelect={() => void action.run((signal) => terminal.query(signal), { quiet: true })}
              >
                重查会话状态
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!session || snapshot.inputState === 'eof'}
                onSelect={() => void action.run((signal) => terminal.eof(signal), { success: null })}
              >
                关闭标准输入
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
              <DropdownMenuItem disabled={lines.length === 0} onSelect={() => terminal.clear()}>
                清空页面输出
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!session} onSelect={() => setRaw((value) => !value)}>
                {raw ? '收起原始会话记录' : '查看原始会话记录'}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div
          ref={output}
          role="log"
          aria-label="终端输出"
          onScroll={(event) => {
            const node = event.currentTarget;
            stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
          }}
          className="min-h-0 flex-1 overflow-auto px-4 py-3 font-mono text-[13px] leading-[1.72] text-[color:var(--media-foreground)]"
        >
          {visible.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <Terminal size={22} className="text-[color:var(--media-muted)]" aria-hidden="true" />
              <p className="font-sans text-[13px] text-[color:var(--media-foreground)]">
                {session ? '等待会话输出' : '还没有打开的会话'}
              </p>
              <p className="max-w-xs font-sans text-[12px] leading-5 text-[color:var(--media-muted)]">
                {session
                  ? '进程已经启动，第一块输出到达后会显示在这里。'
                  : terminalAvailable
                    ? '选一个档案开始新会话，输出会实时出现在这里。'
                    : '终端插件尚未装载，先刷新目录。'}
              </p>
            </div>
          ) : (
            <>
              {lines.length > visible.length && (
                <p className="pb-2 text-[11px] text-[color:var(--media-muted)]">
                  上游还有 {lines.length - visible.length} 行未渲染
                </p>
              )}
              {visible.map((line, index) => (
                <div
                  key={index}
                  className={
                    line.stderr
                      ? 'whitespace-pre-wrap break-words text-[color:color-mix(in_srgb,var(--destructive)_58%,white)]'
                      : 'whitespace-pre-wrap break-words'
                  }
                >
                  {line.text || '\u00a0'}
                </div>
              ))}
            </>
          )}
        </div>

        {session?.status === 'finished' && (
          <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-t border-white/10 bg-white/[0.02] px-3.5 py-2 font-mono text-[11px] text-[color:var(--media-muted)]">
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
          </div>
        )}

        <div className="flex h-14 shrink-0 items-center gap-2 border-t border-white/10 bg-white/[0.03] px-3.5">
          <span
            className="shrink-0 font-mono text-[13px] font-bold text-[color:color-mix(in_srgb,var(--primary)_55%,white)]"
            aria-hidden="true"
          >
            $
          </span>
          <input
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                send();
              }
            }}
            placeholder={
              writable ? '输入命令，Enter 发送' : session ? '当前会话不接受输入' : '会话未打开'
            }
            aria-label="终端输入"
            disabled={!writable}
            className="min-w-0 flex-1 bg-transparent font-mono text-[13px] text-[color:var(--media-foreground)] outline-none placeholder:text-[color:var(--media-muted)] disabled:cursor-not-allowed"
          />
          <span className="hidden shrink-0 font-mono text-[11px] text-[color:var(--media-muted)] sm:inline">
            {inputText[snapshot.inputState]}
          </span>
          <button
            type="button"
            onClick={send}
            disabled={!writable || !command.trim() || action.pending}
            className="h-7 shrink-0 rounded-md bg-[color:var(--primary)] px-3 text-[12px] font-medium text-white transition-colors hover:bg-[color:var(--primary)]/90 disabled:bg-white/10 disabled:text-[color:var(--media-muted)]"
          >
            发送
          </button>
        </div>
      </div>

      {raw && session && (
        <div className="flex max-h-64 shrink-0 flex-col gap-2 overflow-auto rounded-xl border border-[color:var(--hairline)] bg-[color:var(--card)] p-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-[color:var(--text-muted)]">原始会话记录</span>
            <button
              type="button"
              onClick={() => setRaw(false)}
              className="text-[11px] text-[color:var(--text-faint)] hover:text-[color:var(--text-body)]"
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
