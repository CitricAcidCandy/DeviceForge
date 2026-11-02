import type { ApiResult } from "../api/index.js";
import type { JobGateway, JobOptions, JobOutcome, JobTicket, TaskRecord } from "./types.js";
import type { JsonData } from "./values.js";
export declare function createJobRunner(gateway: JobGateway, options?: JobOptions): {
    execute<T>(operation: string, input: JsonData, signal: AbortSignal, decode: (value: unknown, logId: string | null) => T): Promise<JobOutcome<T>>;
    resume<T>(ticket: JobTicket, signal: AbortSignal, decode: (value: unknown, logId: string | null) => T): Promise<JobOutcome<T>>;
    query: (ticket: JobTicket, signal: AbortSignal) => Promise<ApiResult<TaskRecord>>;
    cancel(ticket: JobTicket, signal: AbortSignal): Promise<ApiResult<TaskRecord>>;
    dispose(): void;
};
