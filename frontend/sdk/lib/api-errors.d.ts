import { HostError } from './models.js';
export type ApiErrorKind = HostError['kind'];
export interface HostErrorFields {
    readonly kind: ApiErrorKind;
    readonly code: string;
    readonly message: string;
    readonly status: number | null;
    readonly logId: string | null;
    readonly retryAfter: string | null;
}
/** 兼容既有 HTTP 构造顺序，同时作为公开宿主错误使用。 */
export declare class ApiError extends HostError {
    constructor(kind: ApiErrorKind, code: string, message: string, status?: number | null, logId?: string | null, retryAfter?: string | null);
}
/** 跨窗口或独立 SDK 副本不共享构造器，只读取完整的公开错误字段。 */
export declare function readHostError(value: unknown): HostErrorFields | null;
