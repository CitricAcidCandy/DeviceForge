import { LoaderCircle } from 'lucide-react';
import { Button } from '../../components/Button/index.tsx';
import { ErrorNotice as ErrorMessage } from '../../components/ErrorNotice/index.tsx';
import { errorLogId } from './hooks.ts';

export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : '操作未完成，请重新查询状态';
  return (
    <ErrorMessage
      message={message}
      logId={errorLogId(error)}
      copyLogId={(value) => navigator.clipboard.writeText(value)}
    />
  );
}

export function ActionFeedback({
  pending,
  error,
  logId,
  cancel,
}: {
  pending: boolean;
  error: unknown;
  logId: string | null;
  cancel(): void;
}) {
  return (
    <div aria-live="polite">
      <ErrorNotice error={error} />
      {pending && (
        <div className="operation-progress">
          <LoaderCircle className="inline-spinner" />
          <span>正在等待真实结果</span>
          <Button variant="ghost" size="sm" onClick={cancel}>
            取消等待
          </Button>
        </div>
      )}
      {logId && !error && <p className="log-id">日志 ID：{logId}</p>}
    </div>
  );
}
