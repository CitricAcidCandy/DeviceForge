import type { HistoricalJob, HostResult, Job, JsonValue } from '@deviceforge/plugin-sdk';

export type LogOrder = 'asc' | 'desc';
export interface TaskProgress {
  readonly stage: 'preparing' | 'downloading' | 'verifying' | 'deploying' | 'activating' | 'complete';
  readonly resource_id: string | null;
  readonly completed_bytes: number;
  readonly total_bytes: number | null;
}
export interface TaskEvent {
  readonly sequence: number;
  readonly jobId: string;
  readonly status: Job['status'];
  readonly timestamp: number;
  readonly progress?: TaskProgress | null;
}
export interface LogEntry {
  readonly timestamp: string;
  readonly level: string;
  readonly message: string;
  readonly job_id: string | null;
  readonly operation: string | null;
  readonly code: string | null;
  readonly method: string | null;
  readonly route: string | null;
  readonly log_id: string | null;
  readonly status: number | null;
}
export interface LogSearch {
  readonly log_id: string | null;
  readonly limited: boolean;
  readonly entries: readonly LogEntry[];
  readonly job_ids: readonly string[];
}
export interface TaskLookup {
  readonly query: string;
  readonly jobs: readonly HistoricalJob[];
  readonly logs: LogSearch | null;
  readonly missingJobIds: readonly string[];
}
export interface TaskArtifact {
  readonly id: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly size: number;
  readonly createdAt: number;
  readonly sha256: string;
}
export interface TaskPublication {
  readonly result: JsonValue;
  readonly artifacts: readonly TaskArtifact[];
}
export interface TaskSelection {
  readonly result: HostResult<HistoricalJob> | null;
  readonly cancellation: {
    readonly id: string;
    readonly state: 'requested' | 'unknown' | 'cancelled' | 'finished';
    readonly logId: string | null;
  } | null;
}
