// SDK 公共基础模型与错误，不依赖宿主模块或 HTTP 生成类型。
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type Dispose = () => void | Promise<void>;
export interface HostResult<T> { readonly data: T; readonly logId: string | null }
export interface Operation { readonly id: string; readonly title: string; readonly input_schema: JsonValue }
export interface Job { readonly id: string; readonly operation: string; readonly status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'; readonly result: JsonValue; readonly error: string | null }
export class HostError extends Error {
  readonly kind: 'http' | 'network' | 'cancelled' | 'protocol';
  readonly code: string;
  readonly logId: string | null;
  readonly status: number | null;
  readonly retryAfter: string | null;
  constructor(kind: HostError['kind'], code: string, message: string, logId: string | null = null, status: number | null = null, retryAfter: string | null = null) {
    super(message); this.name = 'HostError';
    this.kind = kind; this.code = code; this.logId = logId; this.status = status; this.retryAfter = retryAfter;
  }
}
