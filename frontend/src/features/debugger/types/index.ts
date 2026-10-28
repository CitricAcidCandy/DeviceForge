import type { JsonValue } from '../../../plugin-sdk/index.ts';
import type { DebuggerBatchDto, DebuggerBridgePluginDto, DebuggerGateway } from '../../../services/api/index.ts';

export type BridgeCommand = DebuggerBatchDto['commands'][number];
export interface DebuggerBridgeOptions {
  readonly gateway: DebuggerGateway;
  readonly signal: AbortSignal;
  readonly directory: () => readonly DebuggerBridgePluginDto[];
  readonly select: (targets: readonly { plugin_id: string; generation: string | null }[]) => void;
  readonly execute: (command: BridgeCommand, signal: AbortSignal) => Promise<JsonValue>;
  readonly heartbeatMs?: number;
}
export interface DebuggerBridgeSnapshot {
  readonly instanceId: string | null;
  readonly state: 'idle' | 'connecting' | 'connected' | 'disconnected' | 'closed';
  readonly activeSessions: number;
  readonly inflight: number;
  readonly unconfirmedReceipts: number;
  readonly reason: string | null;
}
