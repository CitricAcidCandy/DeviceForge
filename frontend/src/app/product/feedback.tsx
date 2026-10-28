import { useEffect, useRef } from 'react';
import { useMessage } from '../../components/Message/index.tsx';
import { describeActionError } from './error-feedback.ts';
import { isCancelledAction } from './hooks.ts';

export function ErrorNotice({ error }: { error: unknown }) {
  const messages = useMessage();
  const previous = useRef<{ error: unknown; controller: typeof messages } | null>(null);
  useEffect(() => {
    if (!error || !messages || isCancelledAction(error)) {
      previous.current = null;
      return;
    }
    if (previous.current?.error === error && previous.current.controller === messages) return;
    previous.current = { error, controller: messages };
    const feedback = describeActionError(error, () => window.location.reload());
    messages[feedback.level](feedback.title, feedback.options);
  }, [error, messages]);
  return null;
}

export function ActionFeedback(_props: {
  pending: boolean;
  error: unknown;
  logId: string | null;
  cancel(): void;
}) {
  // 操作钩子统一管理消息，兼容调用点不再生成页面反馈占位。
  return null;
}
