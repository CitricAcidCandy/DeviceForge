import { useEffect, useId, useState } from 'react';
import { ChevronDown, LoaderCircle } from 'lucide-react';
import { Button } from '../../../../components/Button/index.tsx';
import { ErrorNotice } from '../../../../app/product/feedback.tsx';
import { errorLogId } from '../../../../app/product/hooks.ts';
import type { PluginRecoverySnapshot } from '../../../../features/plugin-recovery/index.ts';
import { cn } from '../../../../utils/classnames.ts';

export { usePluginRecovery } from './use-plugin-recovery.ts';

const checkLabels = { confirmed: '已确认', blocked: '未确认', busy: '占用中' };
const resourceLabels: Readonly<Record<string, string>> = {
  process: '插件进程',
  session: '投屏会话',
  device: '设备资源',
  control: '设备控制权',
  forward: '设备转发',
  ledger: '资源记录',
};

export function RecoveryPanel({
  state,
  activeSession,
  recover,
  refresh,
  cancel,
}: {
  readonly state: PluginRecoverySnapshot;
  readonly activeSession: boolean;
  readonly recover: (signal: AbortSignal) => Promise<unknown>;
  readonly refresh: (signal: AbortSignal) => Promise<unknown>;
  readonly cancel: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  useEffect(() => setExpanded(false), [state.target?.key]);
  const view = state.result?.data;
  const report = view?.last_report;
  const pending = state.phase !== 'idle';
  const busy = Boolean(view?.recovering);
  const attention = Boolean(
    state.error ||
      state.unavailable ||
      view?.supported === false ||
      view?.cleanup_failed ||
      report?.status === 'blocked' ||
      report?.status === 'busy',
  );
  const logId = errorLogId(state.error);
  const title =
    state.phase === 'recovering' || busy
      ? '正在核对投屏资源'
      : state.phase === 'reading'
        ? '正在读取恢复状态'
        : state.unavailable
          ? '需要升级宿主以使用恢复入口'
          : state.error
            ? '核对恢复未完成'
            : !state.target
              ? '正在准备投屏恢复入口'
              : view?.supported === false
                ? '当前插件未提供恢复能力'
                : report?.status === 'busy'
                  ? '投屏连接正在使用中'
                  : report?.status === 'blocked'
                    ? '投屏连接待恢复'
                    : view?.cleanup_failed
                      ? '投屏连接待恢复'
                      : report?.status === 'recovered'
                        ? '资源核对已通过'
                        : view
                          ? '可核对并恢复投屏资源'
                          : '尚未读取恢复状态';
  const invoke = (command: (signal: AbortSignal) => Promise<unknown>) => {
    void command(new AbortController().signal).catch(() => undefined);
  };
  return (
    <section
      className="min-w-0 border-t border-border/60 pt-2 text-xs"
      aria-label="投屏恢复"
      aria-busy={pending || busy}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        {(attention || pending || busy) && (
          <span
            role="status"
            aria-live="polite"
            className={cn(
              'mr-auto inline-flex min-w-0 items-center gap-1.5',
              attention ? 'text-warning' : 'text-muted-foreground',
            )}
          >
            {(pending || busy) && (
              <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
            )}
            {title}
          </span>
        )}
        {attention && (
          <Button
            size="sm"
            variant="outline"
            className="h-8 px-2 text-xs"
            disabled={
              !state.target ||
              pending ||
              busy ||
              activeSession ||
              state.unavailable ||
              view?.supported === false
            }
            onClick={() => invoke(recover)}
          >
            {state.target?.deviceId ? '核对并恢复' : '核对全部投屏资源'}
          </Button>
        )}
        {pending && (
          <Button size="sm" variant="ghost" className="h-8 px-2 text-xs" onClick={cancel}>
            取消等待
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-8 gap-1 px-1.5 text-xs text-muted-foreground"
          aria-expanded={expanded}
          aria-controls={detailId}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? '收起详情' : attention || pending || busy ? '查看详情' : '连接排查'}
          <ChevronDown
            className={cn('size-3.5 transition-transform', expanded && 'rotate-180')}
            aria-hidden="true"
          />
        </Button>
      </div>
      {expanded && (
        <div
          id={detailId}
          className="mt-2 flex min-w-0 flex-col gap-3 border-l-2 border-border/70 py-1 pl-3"
        >
          {!attention && !pending && !busy && (
            <p role="status" aria-live="polite" className="text-muted-foreground">
              {title}
            </p>
          )}
          <p className="break-all text-xs text-muted-foreground">
            {state.target?.deviceId
              ? `核对目标：${state.target.deviceId}`
              : '核对目标：全部投屏资源（全插件）'}
          </p>
          {state.unavailable && (
            <p className="text-xs text-warning">
              当前宿主未提供恢复接口（404），请升级宿主后重试。原投屏错误与日志仍保留。
            </p>
          )}
          {state.error !== null && (
            <div className="flex flex-col gap-1 text-xs text-destructive" role="alert">
              <p className="break-words">
                {state.error instanceof Error
                  ? state.error.message
                  : '恢复请求失败，请重新读取状态'}
              </p>
              {logId && (
                <p className="break-all">
                  日志 ID：<code className="select-all font-mono">{logId}</code>
                </p>
              )}
            </div>
          )}
          {state.cancelled && (
            <p className="text-xs text-muted-foreground" role="status">
              已停止等待，服务器可能仍在处理；请读取状态确认结果。
            </p>
          )}
          {busy && (
            <p className="text-xs text-muted-foreground">
              服务器正在核对，请稍后读取状态，不会重复提交恢复。
            </p>
          )}
          {report && (
            <div className="flex min-w-0 flex-col gap-2">
              <p className="text-xs text-muted-foreground">
                {state.reportTarget === state.target?.key ? '本次核对报告' : '插件最近核对报告'}
                {' · '}覆盖整个插件{' · '}已检查 {report.inspected} 项{' · '}未确认{' '}
                {report.remaining} 项
              </p>
              <p className="break-words text-xs">{report.message}</p>
              <ul
                className="flex max-h-56 flex-col gap-2 overflow-y-auto"
                aria-label="资源核对明细"
              >
                {report.checks.map((check, index) => (
                  <li
                    key={`${index}:${check.resource}`}
                    className="rounded-md bg-muted/50 p-2 text-xs"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-1">
                      <span className="break-all font-medium">
                        {resourceLabels[check.resource] ?? check.resource}
                      </span>
                      <span
                        className={cn(
                          'font-medium',
                          check.status === 'confirmed' ? 'text-success' : 'text-warning',
                        )}
                      >
                        {checkLabels[check.status]}
                      </span>
                    </div>
                    <p className="mt-1 break-words text-muted-foreground">{check.message}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {view?.supported === false && (
            <p className="text-xs text-warning">请升级投屏插件以使用资源核对与恢复。</p>
          )}
          {activeSession && (
            <p className="text-xs text-muted-foreground">请先释放当前投屏会话，再核对并恢复。</p>
          )}
          <div className="flex flex-wrap gap-2">
            {!attention && (
              <Button
                size="sm"
                variant="outline"
                disabled={
                  !state.target ||
                  pending ||
                  busy ||
                  activeSession ||
                  state.unavailable ||
                  view?.supported === false
                }
                onClick={() => invoke(recover)}
              >
                {state.target?.deviceId ? '核对并恢复' : '核对全部投屏资源'}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={!state.target || pending}
              onClick={() => invoke(refresh)}
            >
              读取状态
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            核对通过后，请点击“开始投屏”。不会重放设备操作。
          </p>
        </div>
      )}
      <ErrorNotice error={state.error} />
    </section>
  );
}
