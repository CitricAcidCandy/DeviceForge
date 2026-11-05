import type { ApiClient, ClientOptions, DebuggerBatchDto, DebuggerStatusDto } from '../api/index.ts';
import type { components } from '../api/generated.ts';

export type RealtimeNamespace = '/debugger' | '/tasks';
export type RealtimeCommandResult = components['schemas']['DebuggerCommandResult'];
export type RealtimeBridgeOpen = components['schemas']['DebuggerBridgeOpen'];
export type RealtimeBridgeOpened = components['schemas']['DebuggerBridgeOpened'];
export type RealtimeCapabilities = components['schemas']['RealtimeCapabilities'];
export type RealtimeTasksChanged = components['schemas']['RealtimeTasksChanged'];
export interface RealtimeState {
  readonly state: 'ready' | 'changed' | 'unavailable';
  readonly revision: string | null;
  readonly reset: boolean;
}
export interface RealtimeSocket {
  connected(): boolean;
  connect(): void;
  disconnect(): void;
  on(event: string, listener: (value: unknown) => void): () => void;
  onConnect(listener: () => void): () => void;
  onDisconnect(listener: () => void): () => void;
  onError(listener: () => void): () => void;
  send(event: string, value: unknown, reply: (value: unknown) => void): void;
}
export interface RealtimeManager {
  socket(namespace: RealtimeNamespace): RealtimeSocket;
  dispose(): void;
}
export interface RealtimeManagerOptions {
  readonly baseUrl: string;
  readonly signal: AbortSignal;
  readonly tokenProvider?: ClientOptions['tokenProvider'];
}
export type RealtimeManagerFactory = (options: RealtimeManagerOptions) => Promise<RealtimeManager>;
export interface RealtimeOptions extends RealtimeManagerOptions {
  readonly client: ApiClient;
  readonly factory?: RealtimeManagerFactory;
  readonly reconnectMs?: number;
}
export interface RealtimeChannel {
  readonly supported: Promise<boolean>;
  connected(): boolean;
  subscribe(listener: (state: RealtimeState) => void): () => void;
  on(event: string, listener: (value: unknown) => void): () => void;
  request(event: string, value: unknown, signal: AbortSignal, timeoutMs?: number): Promise<unknown>;
  reconnect(): void;
  release(): void;
}
export interface BridgeConnection {
  readonly instanceId: string;
  readonly resumeKey: string;
  readonly status: DebuggerStatusDto;
  readonly commands: readonly RealtimeCommandResult[];
}
export type RealtimeBatch = DebuggerBatchDto;
