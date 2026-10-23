import type { SessionChunkView } from '../../features/interactive-sessions/index.ts';

/** 每块原字节只写一次；清屏只清显示，不撤销仍由宿主持有的会话。 */
export function createTerminalOutputCursor() {
  let sequence = 0;
  let consumed = 0;
  return {
    append(chunks: readonly SessionChunkView[], write: (bytes: Uint8Array) => void) {
      if (chunks.length < consumed) consumed = 0;
      for (const chunk of chunks.slice(consumed)) {
        if (chunk.sequence <= sequence) continue;
        write(Uint8Array.from(chunk.bytes));
        sequence = chunk.sequence;
      }
      consumed = chunks.length;
    },
  };
}
