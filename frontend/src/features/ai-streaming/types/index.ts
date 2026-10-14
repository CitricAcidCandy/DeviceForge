import type { ApiError, SessionDefinitions, SessionInfo, SessionOutputPage, SessionOutputQuery } from '../../../shared/api/index.ts';

export interface AiStreamInput {
  readonly project_id: string;
  readonly prompt: string;
  readonly thread_id?: string;
}
export type AiStreamOwner = Omit<AiStreamInput, 'prompt'>;
export type AiItemKind = 'agent_message' | 'reasoning' | 'command_execution' | 'file_change' | 'mcp_tool_call' | 'web_search' | 'todo_list';
export interface AiStreamItem {
  readonly id: string;
  readonly type: AiItemKind;
  readonly status?: 'in_progress' | 'completed' | 'failed';
  readonly text?: string;
}
export type AiStreamEvent =
  | { readonly format_version: 1; readonly type: 'thread.started'; readonly thread_id: string }
  | { readonly format_version: 1; readonly type: 'turn.started' }
  | { readonly format_version: 1; readonly type: 'turn.completed' }
  | { readonly format_version: 1; readonly type: 'item.started' | 'item.updated' | 'item.completed'; readonly item: AiStreamItem };
export interface AiObservedEvent {
  readonly firstSequence: number;
  readonly sequence: number;
  readonly event: AiStreamEvent;
}
export interface AiObservedItem {
  readonly sequence: number;
  readonly completed: boolean;
  readonly item: AiStreamItem;
}
export type AiStreamChunk = Readonly<Omit<SessionOutputPage['chunks'][number], 'bytes'> & { readonly bytes: readonly number[] }>;
export interface AiStreamView {
  readonly cursor: number;
  readonly chunks: readonly AiStreamChunk[];
  readonly events: readonly AiObservedEvent[];
  readonly items: readonly AiObservedItem[];
  readonly threadId: string | null;
  readonly text: string;
  readonly providerCompleted: boolean;
  readonly pendingBytes: number;
}
export interface AiStreamResult {
  readonly project_id: string;
  readonly thread_id: string;
  readonly text: string;
  readonly turns: string;
  readonly stream_format_version: 1;
  readonly provider: 'codex_cli';
  readonly resource_scope: 'direct_process';
}
export type AiStreamAction = 'definitions' | 'records' | 'open' | 'resume' | 'query' | 'output' | 'cancel';
export type AiDefinitionsView = Readonly<Omit<SessionDefinitions, 'sessions'> & { readonly sessions: readonly Readonly<SessionDefinitions['sessions'][number]>[] }>;
export interface AiStreamingSnapshot {
  readonly definitions: AiDefinitionsView | null;
  readonly records: readonly Readonly<SessionInfo>[];
  readonly session: Readonly<SessionInfo> | null;
  readonly owner: AiStreamOwner | null;
  readonly stream: AiStreamView;
  readonly result: AiStreamResult | null;
  readonly terminalError: ApiError | null;
  readonly pending: readonly AiStreamAction[];
  readonly logs: Readonly<Partial<Record<AiStreamAction, string | null>>>;
  readonly errors: Readonly<Partial<Record<AiStreamAction, ApiError>>>;
}
export interface AiStreamingOptions { readonly pollIntervalMs?: number }
export type AiStreamReadOptions = Pick<SessionOutputQuery, 'limit'>;
