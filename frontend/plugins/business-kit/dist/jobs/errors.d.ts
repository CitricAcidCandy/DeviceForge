import type { TaskRecord } from "./types.js";
import { JobFailure as PublicJobFailure, JobWaitFailure as PublicJobWaitFailure } from '@deviceforge/plugin-sdk';
export declare const JobFailure: {
    new (job: import("@deviceforge/plugin-sdk").Job, submitLogId: string | null, logId: string | null): PublicJobFailure<import("@deviceforge/plugin-sdk").Job>;
};
export type JobFailure = PublicJobFailure<TaskRecord>;
export declare const JobWaitFailure: {
    new (job: import("@deviceforge/plugin-sdk").Job, submitLogId: string | null, logId: string | null, cause: unknown, lastKnownLogId?: string | null): PublicJobWaitFailure<import("@deviceforge/plugin-sdk").Job>;
};
export type JobWaitFailure = PublicJobWaitFailure<TaskRecord>;
