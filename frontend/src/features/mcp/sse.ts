import { abortable } from '../../shared/api/abort.ts';
import { ApiError } from '../../shared/api/index.ts';

const maxEventBytes = 1024 * 1024;

function protocol(message: string): ApiError {
  return new ApiError('protocol', 'invalid_sse', message);
}

export async function* readSse(response: Response, signal: AbortSignal): AsyncGenerator<string> {
  if (!response.body) throw protocol('MCP 订阅响应缺少 SSE 数据流');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const encoder = new TextEncoder();
  let pending = '';
  let data: string[] = [];
  let bytes = 0;
  const consume = (line: string): string | null => {
    if (line === '') {
      if (data.length === 0) return null;
      const event = data.join('\n'); data = []; bytes = 0; return event;
    }
    if (line.startsWith(':')) return null;
    if (line.startsWith('data:')) {
      const value = line.startsWith('data: ') ? line.slice(6) : line.slice(5);
      bytes += encoder.encode(value).byteLength;
      if (bytes > maxEventBytes) throw protocol('MCP SSE 单事件超过大小上限');
      data.push(value); return null;
    }
    if (/^(?:event|id|retry):/.test(line)) return null;
    throw protocol('MCP SSE 包含未知字段');
  };
  try {
    while (true) {
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) break;
      if (!chunk.value) continue;
      pending += decoder.decode(chunk.value, { stream: true });
      const lines = pending.split('\n'); pending = lines.pop() ?? '';
      for (const raw of lines) {
        const event = consume(raw.endsWith('\r') ? raw.slice(0, -1) : raw);
        if (event !== null) yield event;
      }
    }
    pending += decoder.decode();
    if (pending) {
      const event = consume(pending.endsWith('\r') ? pending.slice(0, -1) : pending);
      if (event !== null) yield event;
    }
    if (data.length) yield data.join('\n');
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (signal.aborted) throw new ApiError('cancelled', 'cancelled', 'MCP SSE 订阅等待已取消');
    throw protocol('MCP SSE 数据不是有效 UTF-8');
  } finally {
    try { await reader.cancel(); } catch { }
    reader.releaseLock();
  }
}
