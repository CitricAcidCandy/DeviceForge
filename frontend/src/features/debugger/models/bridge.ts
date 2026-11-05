import type { DebuggerBridgeOptions, DebuggerBridgeSnapshot } from '../types/index.ts';
import { createHttpDebuggerBridge } from './http-bridge.ts';
import { createSocketDebuggerBridge } from './socket-bridge.ts';

/** 只有能力明确缺失才选择 HTTP，临时断线不建立竞争传输。 */
export function createDebuggerBridge(options: DebuggerBridgeOptions) {
  type Bridge = ReturnType<typeof createHttpDebuggerBridge> | ReturnType<typeof createSocketDebuggerBridge>;
  let bridge: Bridge | null = null, started: Promise<void> | null = null;
  let closed = false;
  let channel: ReturnType<NonNullable<DebuggerBridgeOptions['realtime']>['acquire']> | null = null;
  let failure: string | null = null;
  return {
    start(): Promise<void> {
      if (closed) return Promise.reject(new Error('调试桥已关闭'));
      if (bridge) return bridge.start();
      if (started) return started;
      started = (async () => {
        if (options.realtime) {
          channel = options.realtime.acquire('/debugger');
          const available = await channel.supported;
          if (closed || options.signal.aborted) { channel.release(); return; }
          if (available) bridge = createSocketDebuggerBridge(options, channel);
          else { channel.release(); channel = null; }
        }
        if (closed || options.signal.aborted) { channel?.release(); return; }
        bridge ??= createHttpDebuggerBridge(options);
        await bridge.start();
      })().catch((error: unknown) => {
        failure = error instanceof Error ? error.message : '调试连接未能启动，普通业务仍可继续';
        throw error;
      });
      return started;
    },
    snapshot(): DebuggerBridgeSnapshot {
      return bridge?.snapshot() ?? { instanceId: null, state: closed ? 'closed' : failure ? 'disconnected' : started ? 'connecting' : 'idle',
        activeSessions: 0, inflight: 0, unconfirmedReceipts: 0, reason: failure };
    },
    directoryChanged() {
      if (bridge && 'directoryChanged' in bridge) void bridge.directoryChanged();
    },
    async dispose() {
      if (closed) return;
      closed = true;
      if (bridge) await bridge.dispose(); else channel?.release();
    },
  };
}
