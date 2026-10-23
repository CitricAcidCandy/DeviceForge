import { Button } from '../../../../components/Button/index.tsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../../components/Select/index.tsx';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '../../../../components/Sheet/index.tsx';
import { Field } from '../../../../components/index.ts';
import { cn } from '../../../../utils/classnames.ts';

export type AiMode = 'stream' | 'single' | 'turn' | 'assistant';

export interface QualificationView {
  readonly ready: boolean;
  readonly projects: readonly string[];
  readonly reason: string | null;
}

export interface ThreadStatusView {
  readonly closed: boolean;
  readonly uncertain: boolean;
  readonly turns: string;
}

const modeLabels: Readonly<Record<AiMode, string>> = {
  stream: '实时回答',
  single: '单次任务',
  turn: '线程续聊',
  assistant: '编排助手',
};

/**
 * 对话设置抽屉：连接方式、执行方式、项目与线程、线程操作。
 * 主界面不再常驻这些内容，配置类动作统一收在这里。
 */
export function AiSettingsSheet({
  open,
  onOpenChange,
  provider,
  onProviderChange,
  mode,
  onModeChange,
  project,
  onProjectChange,
  thread,
  onThreadChange,
  resumeId,
  onResumeIdChange,
  busy,
  canStatus,
  canQuery,
  canClose,
  qualification,
  threadStatus,
  records,
  onRefresh,
  onCheckStatus,
  onQueryThread,
  onCloseThread,
  onResume,
  onQuerySession,
  hasSession,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: 'sdk' | 'cli';
  onProviderChange: (value: 'sdk' | 'cli') => void;
  mode: AiMode;
  onModeChange: (value: AiMode) => void;
  project: string;
  onProjectChange: (value: string) => void;
  thread: string;
  onThreadChange: (value: string) => void;
  resumeId: string;
  onResumeIdChange: (value: string) => void;
  busy: boolean;
  canStatus: boolean;
  canQuery: boolean;
  canClose: boolean;
  qualification: QualificationView | null;
  threadStatus: ThreadStatusView | null;
  records: readonly { readonly id: string; readonly status: string }[];
  onRefresh: () => void;
  onCheckStatus: () => void;
  onQueryThread: () => void;
  onCloseThread: () => void;
  onResume: () => void;
  onQuerySession: () => void;
  hasSession: boolean;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-[22.5rem]">
        <SheetHeader className="border-b border-[color:var(--hairline)] px-5 py-4">
          <SheetTitle className="text-[14px] font-semibold text-[color:var(--text-strong)]">
            对话设置
          </SheetTitle>
          <SheetDescription className="text-[12px] text-[color:var(--text-faint)]">
            连接方式与线程操作只影响新请求。
          </SheetDescription>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
          <section className="flex flex-col gap-2">
            <h3 className="text-[11px] font-medium tracking-[0.12em] text-[color:var(--text-faint)]">
              连接方式
            </h3>
            <div className="flex gap-1 rounded-[7px] bg-[color:var(--surface-sunken)] p-1">
              {(['sdk', 'cli'] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => onProviderChange(item)}
                  className={cn(
                    'flex-1 rounded-[5px] py-1.5 text-[12px] font-medium transition-colors',
                    provider === item
                      ? 'bg-[color:var(--card)] text-[color:var(--text-strong)] shadow-sm'
                      : 'text-[color:var(--text-muted)]',
                  )}
                >
                  {item === 'sdk' ? 'Codex SDK' : 'Codex CLI'}
                </button>
              ))}
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-[11px] font-medium tracking-[0.12em] text-[color:var(--text-faint)]">
              执行方式
            </h3>
            <Select
              value={mode}
              disabled={busy}
              onValueChange={(value) => {
                if (value === 'stream' || value === 'single' || value === 'turn' || value === 'assistant')
                  onModeChange(value);
              }}
            >
              <SelectTrigger aria-label="执行方式">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="stream">{modeLabels.stream}</SelectItem>
                <SelectItem value="single">{modeLabels.single}</SelectItem>
                <SelectItem value="turn">{modeLabels.turn}</SelectItem>
                {provider === 'sdk' && (
                  <SelectItem value="assistant">{modeLabels.assistant}</SelectItem>
                )}
              </SelectContent>
            </Select>
          </section>

          <section className="flex flex-col gap-3">
            <h3 className="text-[11px] font-medium tracking-[0.12em] text-[color:var(--text-faint)]">
              项目与线程
            </h3>
            <Field
              label="项目 ID"
              value={project}
              onChange={onProjectChange}
              placeholder="服务器白名单中的 ID"
            />
            <Field label="线程 ID" value={thread} onChange={onThreadChange} placeholder="留空则新建" />
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-[11px] font-medium tracking-[0.12em] text-[color:var(--text-faint)]">
              实时会话
            </h3>
            {records.length === 0 ? (
              <p className="text-[12px] text-[color:var(--text-ghost)]">还没有记录。</p>
            ) : (
              <div className="flex flex-col gap-0.5">
                {records.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onResumeIdChange(item.id)}
                    className={cn(
                      'flex items-center justify-between gap-2 rounded-[5px] px-2 py-1.5 text-left transition-colors',
                      resumeId === item.id
                        ? 'bg-[color:var(--accent)]'
                        : 'hover:bg-[color:var(--surface-hover)]',
                    )}
                  >
                    <span className="truncate font-mono text-[11px] text-[color:var(--text-body)]">
                      {item.id.slice(0, 12)}
                    </span>
                    <span className="shrink-0 text-[11px] text-[color:var(--text-faint)]">
                      {item.status}
                    </span>
                  </button>
                ))}
              </div>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={!resumeId || !project || busy}
              onClick={onResume}
            >
              恢复所选会话
            </Button>
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-[11px] font-medium tracking-[0.12em] text-[color:var(--text-faint)]">
              线程操作
            </h3>
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" variant="ghost" disabled={busy} onClick={onRefresh}>
                刷新目录
              </Button>
              <Button size="sm" variant="ghost" disabled={!canStatus || busy} onClick={onCheckStatus}>
                检查配置
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!thread || !project || !canQuery || busy}
                onClick={onQueryThread}
              >
                查询线程
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!thread || !project || !canClose || busy}
                onClick={onCloseThread}
              >
                关闭线程
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!hasSession || busy}
                onClick={onQuerySession}
              >
                查询会话状态
              </Button>
            </div>
            {qualification && (
              <p className="text-[12px] leading-[1.6] text-[color:var(--text-muted)]">
                <span
                  className={cn(
                    'mr-1',
                    qualification.ready
                      ? 'text-[color:var(--success)]'
                      : 'text-[color:var(--warning)]',
                  )}
                >
                  ●
                </span>
                {qualification.ready ? '运行资格就绪' : '运行资格未就绪'}
                {qualification.reason ? ` · ${qualification.reason}` : ''}
              </p>
            )}
            {qualification && qualification.projects.length > 0 && (
              <p className="font-mono text-[11px] leading-[1.6] text-[color:var(--text-ghost)]">
                可用项目：{qualification.projects.join('、')}
              </p>
            )}
            {threadStatus && (
              <p className="text-[12px] leading-[1.6] text-[color:var(--text-muted)]">
                线程{threadStatus.closed ? '已关闭' : '开放'} · {threadStatus.turns} 轮 ·{' '}
                {threadStatus.uncertain ? '状态待确认' : '状态已确认'}
              </p>
            )}
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
