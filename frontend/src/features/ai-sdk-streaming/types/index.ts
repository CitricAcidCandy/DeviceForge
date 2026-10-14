import type {
  ApiError,
  SessionDefinitions,
  SessionInfo,
  SessionOutputPage,
  SessionOutputQuery,
} from '../../../services/api/index.ts';

export interface AiSdkStreamInput {
  readonly project_id: string;
  readonly prompt: string;
  readonly thread_id?: string;
}
export type AiSdkStreamOwner = Omit<AiSdkStreamInput, 'prompt'>;
export type AiSdkItemKind =
  | 'agent_message'
  | 'reasoning'
  | 'command_execution'
  | 'file_change'
  | 'mcp_tool_call'
  | 'web_search'
  | 'todo_list';
export interface AiSdkStreamItem {
  readonly id: string;
  readonly type: AiSdkItemKind;
  readonly status?: 'in_progress' | 'completed' | 'failed';
  readonly text?: string;
}
export type AiSdkStreamEvent =
  | { readonly format_version: 1; readonly type: 'thread.started'; readonly thread_id: string }
  | { readonly format_version: 1; readonly type: 'turn.started' }
  | { readonly format_version: 1; readonly type: 'turn.completed' }
  | {
      readonly format_version: 1;
      readonly type: 'item.started' | 'item.updated' | 'item.completed';
      readonly item: AiSdkStreamItem;
    };
export interface AiSdkObservedEvent {
  readonly firstSequence: number;
  readonly sequence: number;
  readonly event: AiSdkStreamEvent;
}
export interface AiSdkObservedItem {
  readonly sequence: number;
  readonly completed: boolean;
  readonly item: AiSdkStreamItem;
}
export type AiSdkStreamChunk = Readonly<
  Omit<SessionOutputPage['chunks'][number], 'bytes'> & { readonly bytes: readonly number[] }
>;
export interface AiSdkStreamView {
  readonly cursor: number;
  readonly chunks: readonly AiSdkStreamChunk[];
  readonly events: readonly AiSdkObservedEvent[];
  readonly items: readonly AiSdkObservedItem[];
  readonly threadId: string | null;
  readonly text: string;
  readonly turnCompleted: boolean;
  readonly pendingBytes: number;
}
export interface AiSdkStreamResult {
  readonly provider: 'codex_sdk';
  readonly sdk_version: '0.162.1';
  readonly project_id: string;
  readonly thread_id: string;
  readonly text: string;
  readonly turns: string;
  readonly resource_scope: 'sdk_worker_proxy_and_cli';
}
export type AiSdkStreamAction =
  | 'definitions'
  | 'records'
  | 'open'
  | 'resume'
  | 'query'
  | 'output'
  | 'cancel';
export type AiSdkDefinitionsView = Readonly<
  Omit<SessionDefinitions, 'sessions'> & {
    readonly sessions: readonly Readonly<SessionDefinitions['sessions'][number]>[];
  }
>;
export interface AiSdkStreamingSnapshot {
  readonly definitions: AiSdkDefinitionsView | null;
  readonly records: readonly Readonly<SessionInfo>[];
  readonly session: Readonly<SessionInfo> | null;
  readonly owner: AiSdkStreamOwner | null;
  readonly stream: AiSdkStreamView;
  readonly result: AiSdkStreamResult | null;
  readonly terminalError: ApiError | null;
  readonly pending: readonly AiSdkStreamAction[];
  readonly logs: Readonly<Partial<Record<AiSdkStreamAction, string | null>>>;
  readonly errors: Readonly<Partial<Record<AiSdkStreamAction, ApiError>>>;
}
export interface AiSdkStreamingOptions {
  readonly pollIntervalMs?: number;
}
export type AiSdkStreamReadOptions = Pick<SessionOutputQuery, 'limit'>;
