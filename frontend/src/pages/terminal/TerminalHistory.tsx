import { useEffect } from 'react';
import { Button } from '../../components/Button/index.tsx';
import { useAction } from '../../app/product/hooks.ts';
import type { ProductServices } from '../../app/product/services.ts';
import type { SessionInfoView } from '../../features/interactive-sessions/index.ts';

const statusText: Record<string, string> = {
  opening: '启动中',
  running: '运行中',
  stopping: '关闭中',
  finished: '已结束',
};

export function TerminalHistory({
  terminal,
  records,
  currentId,
}: {
  terminal: ProductServices['sessions'];
  records: readonly SessionInfoView[];
  currentId: string | undefined;
}) {
  const action = useAction();
  useEffect(() => {
    void action.run((signal) => terminal.refreshRecords(signal), { quiet: true });
    return () => action.cancel();
    // 只在进入终端时读取；后续通过显式刷新确认远端状态。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal]);
  const history = records.filter(
    (record) =>
      record.operation === 'plugin.terminal.open' &&
      record.plugin_id === 'terminal' &&
      record.id !== currentId,
  );
  return (
    <section
      aria-label="服务器终端记录"
      className="flex flex-col gap-3 rounded-xl border border-[color:var(--hairline)] bg-[color:var(--card)] p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-[color:var(--text-strong)]">服务器终端记录</h2>
          <p className="text-xs text-[color:var(--text-muted)]">
            可关闭并释放刷新前的终端，或删除已结束记录；此处不接回交互。
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={action.pending}
          onClick={() =>
            void action.run((signal) => terminal.refreshRecords(signal), { success: null })
          }
        >
          刷新记录
        </Button>
      </div>
      {history.length === 0 ? (
        <p className="text-xs text-[color:var(--text-muted)]">没有其他终端记录</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {history.map((record) => (
            <li key={record.id} className="flex flex-wrap items-center gap-3 text-sm">
              <span className="font-mono" title={record.id}>
                {record.id.slice(0, 8)}
              </span>
              <span>{statusText[record.status] ?? record.status}</span>
              {record.completion && (
                <span className="text-xs text-[color:var(--text-muted)]">
                  {record.completion.cleanup === 'complete'
                    ? '清理完成'
                    : record.completion.cleanup === 'failed'
                      ? '清理失败'
                      : '清理未确认'}
                </span>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={action.pending}
                aria-label={`${record.status === 'finished' ? '删除记录' : '关闭并释放'} ${record.id.slice(0, 8)}`}
                onClick={() =>
                  void action.run(
                    (signal) =>
                      record.status === 'finished'
                        ? terminal.removeTerminalRecord(record.id, signal)
                        : terminal.closeTerminalRecord(record.id, signal),
                    { success: null },
                  )
                }
              >
                {record.status === 'finished' ? '删除记录' : '关闭并释放'}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {!!action.error && (
        <p role="alert" className="text-sm text-red-600">
          {action.error instanceof Error ? action.error.message : '终端记录操作失败'}
          {action.logId ? `；日志ID：${action.logId}` : ''}
        </p>
      )}
    </section>
  );
}
