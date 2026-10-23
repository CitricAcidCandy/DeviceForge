import { useEffect, useRef, useState } from 'react';
import type { ProductServices } from '../../app/product/services.ts';
import type { TerminalSize } from '../../features/interactive-sessions/index.ts';
import { ApiError } from '../../services/api/index.ts';
import { createTerminalInputQueue } from './input-queue.ts';

export function useTerminalInput(
  terminal: ProductServices['sessions'],
  sessionId: string | undefined,
) {
  const queue = useRef<ReturnType<typeof createTerminalInputQueue> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setError(null);
    if (!sessionId) return;
    let active = true;
    const current = createTerminalInputQueue(
      (message, signal) =>
        message.type === 'input'
          ? terminal.sendTerminalInput(message.text, signal)
          : terminal.resizeTerminal(message, signal),
      (failure) => {
        if (!active) return;
        const detail = failure instanceof Error ? failure.message : '终端输入失败';
        const log =
          failure instanceof ApiError && failure.logId ? `；日志ID：${failure.logId}` : '';
        setError(`${detail}${log}。后续按键已停止发送，请关闭并重新打开会话。`);
      },
    );
    queue.current = current;
    return () => {
      active = false;
      current.dispose();
      if (queue.current === current) queue.current = null;
    };
  }, [terminal, sessionId]);
  return {
    error,
    input: (text: string) => queue.current?.input(text),
    resize: (size: TerminalSize) => queue.current?.resize(size),
  };
}
