import { useState } from 'react';
import { AlertCircle, Copy } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '../Alert/index.tsx';
import { Button } from '../Button/index.tsx';

export interface ErrorNoticeProps {
  readonly message: string;
  readonly logId?: string | null;
  readonly copyLogId?: (value: string) => Promise<void>;
}

export function ErrorNotice({ message, logId, copyLogId }: ErrorNoticeProps) {
  const [copyState, setCopyState] = useState('');
  return (
    <Alert variant="destructive" role="alert">
      <AlertCircle />
      <AlertTitle>操作未完成</AlertTitle>
      <AlertDescription>
        <p>{message}</p>
        {logId &&
          (copyLogId ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void copyLogId(logId).then(
                  () => setCopyState('日志 ID 已复制'),
                  () => setCopyState('复制失败，请手动选择日志 ID'),
                );
              }}
            >
              <Copy />
              复制日志 ID：{logId}
            </Button>
          ) : (
            <p>日志 ID：{logId}</p>
          ))}
        <span role="status">{copyState}</span>
      </AlertDescription>
    </Alert>
  );
}
