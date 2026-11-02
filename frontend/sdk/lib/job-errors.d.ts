import type { Job } from './models.js';
export interface JobFailureState {
    readonly id: string;
    readonly operation: string;
    readonly status: Job['status'];
    readonly result?: unknown;
    readonly error?: string | null;
}
export declare class JobFailure<T extends JobFailureState = JobFailureState> extends Error {
    readonly job: T;
    readonly submitLogId: string | null;
    readonly logId: string | null;
    constructor(job: T, submitLogId: string | null, logId: string | null);
}
export declare class JobWaitFailure<T extends JobFailureState = JobFailureState> extends Error {
    readonly job: T;
    readonly submitLogId: string | null;
    readonly logId: string | null;
    readonly lastKnownLogId: string | null;
    constructor(job: T, submitLogId: string | null, logId: string | null, cause: unknown, lastKnownLogId?: string | null);
}
