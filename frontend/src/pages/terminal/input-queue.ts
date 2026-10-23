import type { TerminalSize } from '../../features/interactive-sessions/index.ts';

export type TerminalMessage =
  | { readonly type: 'input'; readonly text: string }
  | { readonly type: 'resize'; readonly cols: number; readonly rows: number };

const encoder = new TextEncoder();
const byteLength = (message: TerminalMessage) => encoder.encode(JSON.stringify(message)).length;
const MAX_PENDING = 256 * 1024;
const MAX_MESSAGES = 256;

/** 以码点分块，既不切开中文，也不让JSON转义后的消息超出公开输入上限。 */
export function inputMessages(text: string): TerminalMessage[] {
  const messages: TerminalMessage[] = [];
  let pending = '';
  let bytes = byteLength({ type: 'input', text: '' });
  for (const point of text) {
    const added = encoder.encode(JSON.stringify(point)).length - 2;
    if (bytes + added > 8192) {
      messages.push({ type: 'input', text: pending });
      pending = '';
      bytes = byteLength({ type: 'input', text: '' });
    }
    pending += point;
    bytes += added;
  }
  if (pending) messages.push({ type: 'input', text: pending });
  return messages;
}

export function createTerminalInputQueue(
  send: (message: TerminalMessage, signal: AbortSignal) => Promise<unknown>,
  failed: (error: unknown) => void,
) {
  const controller = new AbortController();
  let messages: TerminalMessage[] = [];
  let pendingBytes = 0;
  let running = false;
  let closed = false;

  function stop(error: unknown): void {
    if (closed) return;
    closed = true;
    messages = [];
    pendingBytes = 0;
    controller.abort();
    failed(error);
  }

  async function drain(): Promise<void> {
    if (running || closed) return;
    running = true;
    try {
      while (!closed) {
        const message = messages.shift();
        if (!message) break;
        // 在途消息也计入容量，收据返回前不会发送下一条。
        const bytes = byteLength(message);
        await send(message, controller.signal);
        pendingBytes -= bytes;
      }
    } catch (error) {
      stop(error);
    } finally {
      running = false;
    }
  }

  function admit(next: TerminalMessage[]): void {
    if (closed) return;
    const bytes = next.reduce((sum, message) => sum + byteLength(message), 0);
    if (pendingBytes + bytes > MAX_PENDING || messages.length + next.length > MAX_MESSAGES) {
      stop(new Error('终端输入积压超过上限，已停止发送；请关闭并重新打开会话'));
      return;
    }
    messages.push(...next);
    pendingBytes += bytes;
    void drain();
  }

  return {
    input(text: string) {
      if (encoder.encode(text).length > MAX_PENDING) {
        stop(new Error('粘贴内容超过256 KiB，已停止发送；请关闭并重新打开会话'));
        return;
      }
      admit(inputMessages(text));
    },
    resize(size: TerminalSize) {
      if (closed) return;
      const previous = messages.at(-1);
      if (previous?.type === 'resize') {
        pendingBytes -= byteLength(previous);
        messages.pop();
      }
      admit([{ type: 'resize', ...size }]);
    },
    dispose() {
      closed = true;
      messages = [];
      pendingBytes = 0;
      controller.abort();
    },
  };
}
