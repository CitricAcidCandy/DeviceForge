import type { ReactNode } from 'react';
import { CircleAlert, Copy } from 'lucide-react';
import { Button } from '../../components/Button/index.tsx';
import { useMessage } from '../../components/Message/index.tsx';

export const settingsInputClass =
  'h-9 rounded-[5px] border-hairline-strong bg-card text-[13px]! shadow-none';
export const settingsButtonClass = 'h-9 rounded-[5px]! text-[13px]! shadow-none [&_svg]:size-4!';
export const settingsCodeClass =
  'min-h-40 rounded-[5px] border-hairline-strong bg-card font-mono! text-[13px]! shadow-none';

export function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-5 border-t border-hairline pt-6 [&>a]:self-start [&>button]:self-start">
      <h3 className="text-[15px]! font-medium! text-ink">{title}</h3>
      {children}
    </section>
  );
}

export function SettingsFailure({
  error,
  logId,
  noLogMessage = '未取得日志 ID。',
}: {
  error: unknown;
  logId: string | null;
  noLogMessage?: string;
}) {
  const messages = useMessage();
  if (!error) return null;
  return (
    <div role="alert" className="space-y-1.5 text-[13px]">
      <div className="flex items-start gap-2 text-destructive">
        <CircleAlert className="mt-0.5 size-[18px]! shrink-0" aria-hidden="true" />
        <p className="min-w-0 break-words leading-6">
          {error instanceof Error ? error.message : '操作未完成，请重试。'}
        </p>
      </div>
      {logId ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2 pl-[26px] text-[12px] text-muted-foreground">
          <span className="break-all">日志 ID：{logId}</span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="text-[12px]!"
            onClick={() => {
              if (!navigator.clipboard?.writeText) {
                messages?.warning('当前环境不支持自动复制，请手动选择日志 ID');
                return;
              }
              void navigator.clipboard.writeText(logId).then(
                () => messages?.success('日志 ID 已复制'),
                () => messages?.warning('复制失败，请手动选择日志 ID'),
              );
            }}
          >
            <Copy aria-hidden="true" />
            复制日志 ID
          </Button>
        </div>
      ) : (
        <p className="pl-[26px] text-[12px] leading-6 text-muted-foreground">{noLogMessage}</p>
      )}
    </div>
  );
}
