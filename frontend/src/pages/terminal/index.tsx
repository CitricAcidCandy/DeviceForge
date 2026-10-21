import { useState } from 'react';
import { Button } from '../../components/Button/index.tsx';
import { EmptyState, Field, JsonResult } from '../../components/index.ts';
import { ActionFeedback } from '../../app/product/feedback.tsx';
import { useAction, useSnapshot } from '../../app/product/hooks.ts';
import type { ProductServices } from '../../app/product/services.ts';

const inputText: Record<string, string> = {
  writable: '输入模式',
  readonly: '只读',
  eof: '输入已关闭',
  unknown: '未连接',
};

const stateText: Record<string, string> = {
  opening: '运行中',
  stopping: '关闭中',
  finished: '已结束',
};

export function TerminalPage({ services }: { services: ProductServices }) {
  const terminal = services.sessions;
  const snapshot = useSnapshot(terminal);
  const action = useAction();
  const reader = useAction();
  const [profile, setProfile] = useState('default');
  const [command, setCommand] = useState('');
  const [resumeId, setResumeId] = useState('');
  const terminalAvailable =
    snapshot.definitions?.sessions.some((item) => item.id === 'plugin.terminal.open') ?? false;
  const decoder = new TextDecoder();
  const text =
    snapshot.chunks
      .map((chunk) => decoder.decode(Uint8Array.from(chunk.bytes), { stream: true }))
      .join('') + (snapshot.session?.status === 'finished' ? decoder.decode() : '');
  const lines = text ? text.split('\n').length - 1 : 0;
  const status = snapshot.session?.status ?? null;
  const writable = !!snapshot.session && snapshot.inputState === 'writable';
  const records = snapshot.records.filter((item) => item.operation === 'plugin.terminal.open');
  const send = () => {
    const value = command;
    if (!value.trim() || !writable) return;
    setCommand('');
    void action.run(async (signal) => {
      const result = await terminal.send([...new TextEncoder().encode(value + '\n')], signal);
      return result;
    });
  };
  return (
    <section
      className="product-page terminal-page flex flex-col gap-3"
      data-product-page="terminal"
      aria-label="终端"
    >
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-[22px] font-semibold text-[color:var(--text-strong)]">终端</h1>
          <span className="flex items-center gap-2 font-mono text-[11px] text-[color:var(--text-faint)]">
            <span>{snapshot.session?.id ?? 'sess_未打开'}</span>
            <span>·</span>
            <span>{profile}</span>
            <span>·</span>
            <span
              className={
                status === 'opening'
                  ? 'text-[color:var(--success)]'
                  : status === 'stopping'
                    ? 'text-[color:var(--warning)]'
                    : 'text-[color:var(--text-muted)]'
              }
            >
              ● {status ? (stateText[status] ?? status) : '未打开'}
            </span>
          </span>
        </div>
        <div className="flex items-end gap-2">
          <Button
            variant="outline"
            onClick={() =>
              void action.run(async (signal) => {
                await terminal.refreshDefinitions(signal);
                return terminal.refreshRecords(signal);
              })
            }
          >
            刷新目录
          </Button>
          <Button
            variant="destructive"
            disabled={!snapshot.session || snapshot.session.status === 'finished'}
            onClick={() => void action.run((signal) => terminal.cancel(signal))}
          >
            关闭会话
          </Button>
        </div>
      </header>
      <div className="grid min-h-0 grid-cols-[200px_minmax(0,1fr)] gap-3 h-[calc(100vh-300px)] min-h-[440px]">
        <aside className="flex min-h-0 flex-col gap-3" aria-label="终端连接">
          <div className="flex flex-col gap-2 rounded-[12px] border border-[color:var(--hairline)] bg-[color:var(--card)] p-3">
            <Field label="终端档案" value={profile} onChange={setProfile} placeholder="服务器档案 ID" />
            <Button
              disabled={!terminalAvailable || action.pending}
              onClick={() => void action.run((signal) => terminal.openTerminal(profile, signal))}
            >
              新会话
            </Button>
            {!terminalAvailable && (
              <p className="pt-1 text-[11px] leading-4 text-[color:var(--warning)]">
                刷新目录以读取可用终端档案。
              </p>
            )}
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto rounded-[12px] border border-[color:var(--hairline)] bg-[color:var(--card)] p-2">
            <span className="px-1 pb-1 text-[11px] font-medium text-[color:var(--text-muted)]">会话</span>
            {records.length === 0 ? (
              <p className="px-1 text-[11px] leading-4 text-[color:var(--text-faint)]">
                还没有会话记录。打开一个终端档案。
              </p>
            ) : (
              records.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  data-current={item.id === snapshot.session?.id}
                  onClick={() => void action.run((signal) => terminal.resume(item.id, signal))}
                  className="flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-[color:var(--surface-hover)] data-[current=true]:bg-[color:var(--accent)]"
                >
                  <span className="truncate text-[12px] text-[color:var(--text-body)]">
                    {item.id.slice(0, 8)}
                  </span>
                  <span className="font-mono text-[11px] text-[color:var(--text-faint)]">
                    {stateText[item.status] ?? item.status}
                  </span>
                </button>
              ))
            )}
          </div>
          <details className="rounded-[12px] border border-[color:var(--hairline)] bg-[color:var(--card)] px-3 py-2">
            <summary className="text-[11px] text-[color:var(--text-muted)]">恢复已有会话</summary>
            <div className="flex flex-col gap-2 pt-2">
              <Field label="会话 ID" value={resumeId} onChange={setResumeId} />
              <Button
                variant="outline"
                size="sm"
                disabled={!resumeId || action.pending}
                onClick={() => void action.run((signal) => terminal.resume(resumeId, signal))}
              >
                恢复
              </Button>
            </div>
          </details>
        </aside>
        <div className="flex min-h-0 flex-col overflow-hidden rounded-[12px] border border-[color:var(--hairline)] bg-[color:var(--card)]">
          <div className="flex items-center justify-between gap-3 border-b border-[color:var(--hairline)] px-4 py-2">
            <span className="font-mono text-[11px] text-[color:var(--text-muted)]">
              {profile} · bash
            </span>
            <span className="font-mono text-[11px] text-[color:var(--text-faint)]">
              {lines} 行 · {inputText[snapshot.inputState] ?? snapshot.inputState}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-4 py-3" role="log" aria-label="终端输出">
            {text ? (
              <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.65] text-[color:var(--text-body)]">
                {text}
              </pre>
            ) : (
              <EmptyState title="等待终端输出" description="打开或恢复会话后，输出会显示在这里。" />
            )}
          </div>
          <div className="flex items-center gap-2 border-t border-[color:var(--hairline)] px-4 py-2">
            <span className="font-mono text-[12px] text-[color:var(--primary)]">$</span>
            <input
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  send();
                }
              }}
              placeholder="输入命令，Enter 发送"
              aria-label="终端输入"
              disabled={!writable}
              className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-[color:var(--text-strong)] outline-none placeholder:text-[color:var(--text-ghost)]"
            />
            <span className="shrink-0 font-mono text-[11px] text-[color:var(--text-ghost)]">
              Enter 发送 · Shift+Enter 换行
            </span>
            <Button size="sm" disabled={!writable || action.pending} onClick={send}>
              发送
            </Button>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={!snapshot.session || reader.pending}
          onClick={() => void reader.run((signal) => terminal.pollOutput({ limit: 100 }, signal))}
        >
          持续读取
        </Button>
        <Button size="sm" variant="ghost" disabled={!reader.pending} onClick={reader.cancel}>
          暂停读取
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!snapshot.session}
          onClick={() => void action.run((signal) => terminal.query(signal))}
        >
          重查状态
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!snapshot.session || snapshot.inputState === 'eof'}
          onClick={() => void action.run((signal) => terminal.eof(signal))}
        >
          关闭输入
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={snapshot.session?.status !== 'finished'}
          onClick={() => void action.run((signal) => terminal.remove(signal))}
        >
          删除已结束记录
        </Button>
        <span className="text-[11px] text-[color:var(--text-faint)]">暂停读取不会停止服务器会话。</span>
        <details className="w-full rounded-[12px] border border-[color:var(--hairline)] bg-[color:var(--card)] px-3 py-2">
          <summary className="text-[11px] text-[color:var(--text-muted)]">原始会话</summary>
          <div className="pt-2">
            <JsonResult value={snapshot.session} />
          </div>
        </details>
      </div>
      <ActionFeedback {...action} />
      <ActionFeedback {...reader} />
    </section>
  );
}
