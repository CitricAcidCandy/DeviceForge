import { ApiError } from '../../../services/api/index.ts';
import type { TerminalSize } from '../types/index.ts';

export const TERMINAL_PROTOCOL = 'deviceforge.terminal.v1';

export function terminalSize(size: TerminalSize): TerminalSize {
  if (
    !Number.isSafeInteger(size.cols) ||
    size.cols < 20 ||
    size.cols > 500 ||
    !Number.isSafeInteger(size.rows) ||
    size.rows < 5 ||
    size.rows > 200
  )
    throw new ApiError('protocol', 'invalid_terminal_size', '终端尺寸须为20至500列、5至200行');
  return { cols: size.cols, rows: size.rows };
}

export function terminalInput(text: string): number[] {
  const bytes = new TextEncoder().encode(JSON.stringify({ type: 'input', text }));
  if (bytes.length > 8192)
    throw new ApiError('protocol', 'terminal_input_limit', '单条终端输入消息超过8192字节');
  return [...bytes];
}

export function terminalResize(size: TerminalSize): number[] {
  return [...new TextEncoder().encode(JSON.stringify({ type: 'resize', ...terminalSize(size) }))];
}
