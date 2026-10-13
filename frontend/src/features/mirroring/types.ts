export interface MirroringRequest { readonly device_id: string; readonly duration_ms: number; readonly max_size?: number; readonly max_fps?: number }
export type MirroringStatus = { readonly available: true; readonly version: string; readonly recording: true } & (
  | { readonly live_stream: false }
  | { readonly live_stream: true; readonly live_configured: boolean }
);
export interface MirroringRecording { readonly device_id: string; readonly duration_ms: number; readonly codec: 'h264'; readonly filename: 'screen.mp4'; readonly size: number; readonly live_stream: false }
import type { ApiError, ApiResult, OperationDto } from '../../shared/api/index.ts';
import type { JobOptions } from '../../shared/jobs/index.ts';

export type MirroringAction = 'runtime.status' | 'record';
export interface MirroringOperationReader { readonly list: (signal: AbortSignal) => Promise<ApiResult<unknown>> }
export interface MirroringOptions extends JobOptions { readonly operations?: MirroringOperationReader }
export interface MirroringCatalogSnapshot {
  readonly operations: readonly Readonly<OperationDto>[];
  readonly refreshing: boolean;
  readonly logId: string | null;
  readonly error: ApiError | null;
}
