export type ApiErrorKind = 'http' | 'network' | 'cancelled' | 'protocol';

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly code: string;
  readonly status: number | null;
  readonly logId: string | null;
  readonly retryAfter: string | null;
  constructor(
    kind: ApiErrorKind,
    code: string,
    message: string,
    status: number | null = null,
    logId: string | null = null,
    retryAfter: string | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind; this.code = code; this.status = status; this.logId = logId; this.retryAfter = retryAfter;
  }
}
