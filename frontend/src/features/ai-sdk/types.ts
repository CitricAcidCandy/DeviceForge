import type { ApiError, ApiResult, OperationDto } from '../../shared/api/index.ts';
import type { JobOptions } from '../../shared/jobs/index.ts';

export type AiSdkAction = 'runtime.status' | 'sdk.single' | 'sdk.turn' | 'session.get' | 'session.close' | 'assistant.run';
export interface AiSdkSingleInput { readonly project_id: string; readonly prompt: string }
export interface AiSdkTurnInput extends AiSdkSingleInput { readonly thread_id?: string }
export interface AiSdkThreadInput { readonly project_id: string; readonly thread_id: string }
export interface AiSdkAssistantInput { readonly project_id: string; readonly user_prompt?: string; readonly stream_output?: boolean }
export interface AiSdkOperationReader { readonly list: (signal: AbortSignal) => Promise<ApiResult<unknown>> }
export interface AiSdkOptions extends JobOptions { readonly operations?: AiSdkOperationReader }
export interface AiSdkCatalogSnapshot {
  readonly operations: readonly Readonly<OperationDto>[];
  readonly refreshing: boolean;
  readonly logId: string | null;
  readonly error: ApiError | null;
}
export interface AiSdkTurnResult {
  readonly provider: 'codex_sdk';
  readonly sdk_version: '0.162.1';
  readonly project_id: string;
  readonly thread_id: string;
  readonly text: string;
  readonly turns: string;
  readonly resource_scope: 'sdk_worker_proxy_and_cli';
}
export interface AiSdkRuntimeStatus {
  readonly provider: 'codex_sdk';
  readonly sdk_version: '0.162.1';
  readonly profile: 'codex_sdk_ts_0_162_1_node24';
  readonly configured: boolean;
  readonly node_version: string | null;
  readonly cli_version: string | null;
  readonly sdk_loaded: boolean;
  readonly process_scope_qualified: boolean;
  readonly model_verified: boolean;
  readonly ready: boolean;
  readonly projects: readonly string[];
  readonly reason: string | null;
  readonly resource_scope: 'sdk_worker_proxy_and_cli';
}
export interface AiSdkThreadResult {
  readonly provider: 'codex_sdk';
  readonly sdk_version: '0.162.1';
  readonly profile: 'codex_sdk_ts_0_162_1_node24';
  readonly project_id: string;
  readonly thread_id: string;
  readonly turns: string;
  readonly closed: boolean;
  readonly uncertain: boolean;
  readonly resource_scope: 'sdk_worker_proxy_and_cli';
}
export interface AiSdkAssistantResult extends AiSdkTurnResult {
  readonly assistant_turns: '1' | '2' | '3' | '4';
  readonly stream_output: boolean;
}
