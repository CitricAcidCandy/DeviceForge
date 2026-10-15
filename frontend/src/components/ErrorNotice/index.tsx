import { useEffect, useRef } from 'react';
import { useMessage } from '../Message/index.tsx';
import type { MessageController } from '../Message/index.ts';

export interface ErrorNoticeProps {
  readonly message: string;
  readonly logId?: string | null;
  readonly copyLogId?: (value: string) => Promise<void>;
}

export function ErrorNotice({ message, logId, copyLogId }: ErrorNoticeProps) {
  const messages = useMessage();
  const copyLogIdRef = useRef(copyLogId);
  copyLogIdRef.current = copyLogId;
  const previous = useRef<{
    message: string;
    logId: string | null;
    controller: MessageController;
  } | null>(null);
  useEffect(() => {
    if (!messages || !message) {
      previous.current = null;
      return;
    }
    const currentLogId = logId ?? null;
    if (
      previous.current?.message === message &&
      previous.current.logId === currentLogId &&
      previous.current.controller === messages
    ) return;
    previous.current = { message, logId: currentLogId, controller: messages };
    messages.error(message, {
      logId: currentLogId,
      ...(currentLogId && copyLogId ? {
        action: {
          label: '复制日志 ID',
          onClick: () => {
            const copy = copyLogIdRef.current;
            if (!copy) return;
            void copy(currentLogId).then(
              () => messages.success('日志 ID 已复制'),
              () => messages.warning('复制失败，请手动选择日志 ID'),
            );
          },
        },
      } : {}),
    });
  }, [message, logId, copyLogId, messages]);
  return null;
}
