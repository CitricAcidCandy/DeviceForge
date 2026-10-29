export type JsonValue = null | boolean | number | string | JsonValue[] | {
    [key: string]: JsonValue;
};
export type Dispose = () => void | Promise<void>;
export interface HostResult<T> {
    readonly data: T;
    readonly logId: string | null;
}
export interface OperationExecution {
    readonly apiVersion: 1;
    readonly totalTimeoutMs: number;
    readonly source: 'default' | 'declared';
}
export interface Operation {
    readonly id: string;
    readonly title: string;
    readonly input_schema: JsonValue;
    readonly execution?: OperationExecution;
}
export interface Job {
    readonly id: string;
    readonly operation: string;
    readonly status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
    readonly result: JsonValue;
    readonly error: string | null;
}
export declare class HostError extends Error {
    readonly kind: 'http' | 'network' | 'cancelled' | 'protocol';
    readonly code: string;
    readonly logId: string | null;
    readonly status: number | null;
    readonly retryAfter: string | null;
    constructor(kind: HostError['kind'], code: string, message: string, logId?: string | null, status?: number | null, retryAfter?: string | null);
}
