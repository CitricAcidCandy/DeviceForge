export class HostError extends Error {
    kind;
    code;
    logId;
    status;
    retryAfter;
    constructor(kind, code, message, logId = null, status = null, retryAfter = null) {
        super(message);
        this.name = 'HostError';
        this.kind = kind;
        this.code = code;
        this.logId = logId;
        this.status = status;
        this.retryAfter = retryAfter;
    }
}
