import type { HostResult, Job } from '@deviceforge/plugin-sdk';
import type { JsonData } from "./values.js";
export type TaskRecord = Job;
export interface JobGateway {
    readonly submit: (operation: string, input: JsonData, signal: AbortSignal) => Promise<HostResult<TaskRecord>>;
    readonly getJob: (id: string, signal: AbortSignal) => Promise<HostResult<TaskRecord>>;
    readonly cancelJob: (id: string, signal: AbortSignal) => Promise<HostResult<TaskRecord>>;
}
export interface JobOptions {
    readonly pollIntervalMs?: number;
}
export interface JobOutcome<T> {
    readonly data: T;
    readonly job: TaskRecord;
    readonly submitLogId: string | null;
    readonly logId: string | null;
}
export interface JobTicket {
    readonly id: string;
    readonly operation: string;
    readonly submitLogId: string | null;
}
