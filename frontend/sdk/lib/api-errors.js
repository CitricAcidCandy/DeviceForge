import { HostError } from "./models.js";
/** 兼容既有 HTTP 构造顺序，同时作为公开宿主错误使用。 */
export class ApiError extends HostError {
    constructor(kind, code, message, status = null, logId = null, retryAfter = null) {
        super(kind, code, message, logId, status, retryAfter);
        this.name = 'ApiError';
    }
}
/** 跨窗口或独立 SDK 副本不共享构造器，只读取完整的公开错误字段。 */
export function readHostError(value) {
    if (!value || typeof value !== 'object')
        return null;
    try {
        if (Array.isArray(value))
            return null;
        if (!('kind' in value && 'code' in value && 'message' in value &&
            'status' in value && 'logId' in value && 'retryAfter' in value))
            return null;
        const { kind, code, message, status, logId, retryAfter } = value;
        if (!(kind === 'http' || kind === 'network' || kind === 'cancelled' || kind === 'protocol') ||
            typeof code !== 'string' || typeof message !== 'string' ||
            !(status === null || typeof status === 'number' && Number.isFinite(status)) ||
            !(logId === null || typeof logId === 'string') ||
            !(retryAfter === null || typeof retryAfter === 'string'))
            return null;
        return { kind, code, message, status, logId, retryAfter };
    }
    catch {
        return null;
    }
}
