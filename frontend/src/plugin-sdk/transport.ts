import type { HostResult, JsonValue } from './models.ts';

/** 宿主连接内的公开请求；不能传入服务器地址、凭据或任意本机路径。 */
export interface PluginRequest {
  readonly path: string;
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: JsonValue;
  readonly content?: Blob | ArrayBuffer;
  readonly contentType?: string;
  readonly timeoutMs?: number;
}

export interface PluginJsonRequest extends PluginRequest {
  /** 默认拆解 v2 响应；raw 用于公开的原始 JSON 资源。 */
  readonly envelope?: 'v2' | 'raw';
}

/** 通信只结束请求等待；停止已接受的后台任务仍须显式取消并查询终态。 */
export interface PluginTransport {
  readonly request: (request: PluginJsonRequest, signal: AbortSignal) => Promise<HostResult<JsonValue>>;
  readonly bytes: (request: PluginRequest, signal: AbortSignal) => Promise<HostResult<Blob>>;
  readonly stream: (request: PluginRequest, signal: AbortSignal) => Promise<HostResult<ReadableStream<Uint8Array>>>;
}
