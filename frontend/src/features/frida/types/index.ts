import type { ApiError, ApiResult, OperationDto } from '../../../services/api/index.ts';
import type { JsonData, JobOptions } from '../../../shared/jobs/index.ts';

export type FridaAction =
  | 'server.deploy'
  | 'server.status'
  | 'server.run'
  | 'processes'
  | 'script.run'
  | 'permissions.analyze';
export type FridaMode = 'spawn' | 'attach';
export type PermissionModule =
  | 'permissions'
  | 'phone'
  | 'system'
  | 'packages'
  | 'location'
  | 'camera'
  | 'network'
  | 'bluetooth'
  | 'files'
  | 'media'
  | 'sensor';
export interface FridaScriptInput {
  readonly script_artifact_id: string;
  readonly mode: FridaMode;
  readonly package: string;
  readonly duration_ms: number;
}
export interface PermissionHook {
  readonly class: string;
  readonly method: string;
  readonly module?: string;
  readonly action: string;
  readonly messages: string;
  readonly args?: readonly string[];
}
export interface FridaPermissionsInput {
  readonly mode: FridaMode;
  readonly package: string;
  readonly duration_ms: number;
  readonly modules?: readonly PermissionModule[];
  readonly hooks?: readonly PermissionHook[];
  readonly show_log?: boolean;
}
export interface FridaDeployment {
  readonly deployed: true;
  readonly version_output: string;
  readonly root_required: true;
}
export interface FridaStatus {
  readonly installed: boolean;
  readonly running: boolean;
  readonly pids: readonly number[];
  readonly version_output: string;
  readonly ownership: 'observed_only';
}
export interface FridaServerRun {
  readonly pid: number;
  readonly process_start_ticks: number;
  readonly duration_ms: number;
  readonly cleanup: 'confirmed';
  readonly ownership: 'invocation';
}
export interface FridaProcesses {
  readonly source: 'frida-ps --json';
  readonly processes: readonly { readonly pid: number; readonly name: string }[];
}
export interface FridaScriptResult {
  readonly package: string;
  readonly mode: FridaMode;
  readonly duration_requested_ms: number;
  readonly cli_timeout_seconds: number;
  readonly loaded: true;
  readonly resume: 'cli_default' | 'already_running';
  readonly notice_count: number;
  readonly hook_summary: readonly JsonData[];
  readonly cleanup: 'direct_cli_confirmed';
  readonly target_process_cleanup: 'not_claimed';
}
export interface FridaOperationReader {
  readonly list: (signal: AbortSignal) => Promise<ApiResult<unknown>>;
}
export interface FridaCatalogSnapshot {
  readonly operations: readonly Readonly<OperationDto>[];
  readonly refreshing: boolean;
  readonly logId: string | null;
  readonly error: ApiError | null;
}
export interface FridaOptions extends JobOptions {
  readonly operations?: FridaOperationReader;
}
