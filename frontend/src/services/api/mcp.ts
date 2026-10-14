import { abortable } from './abort.ts';
import { ApiError } from './errors.ts';
import type { ClientOptions } from './client.ts';

export const MCP_PROTOCOL_VERSION = '2026-07-28';

export interface McpHttpResponse {
  readonly requestId: number;
  readonly response: Response;
}

export interface McpTransport {
  readonly request: (method: string, params: Readonly<Record<string, unknown>>, signal: AbortSignal) => Promise<McpHttpResponse>;
}

function cancelled(logId: string | null = null): ApiError {
  return new ApiError('cancelled', 'cancelled', 'MCP 请求等待已取消', null, logId);
}

function validateBase(baseUrl: string): URL {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('MCP 地址必须为不含凭证或查询参数的 HTTP 地址');
  }
  return base;
}

export function createMcpTransport(options: ClientOptions): McpTransport {
  const base = validateBase(options.baseUrl);
  const endpoint = new URL('/mcp', base);
  let nextRequestId = 1;
  async function request(method: string, params: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<McpHttpResponse> {
    if (!method || signal.aborted) throw cancelled();
    const requestId = nextRequestId++;
    const headers = new Headers({
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
      'Mcp-Method': method,
    });
    try {
      const token = await abortable(Promise.resolve(options.tokenProvider?.(signal) ?? null), signal);
      if (signal.aborted) throw cancelled();
      if (token) headers.set('authorization', `Bearer ${token}`);
      const body = JSON.stringify({
        jsonrpc: '2.0', id: requestId, method,
        params: { ...params, _meta: {
          'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
          'io.modelcontextprotocol/clientInfo': { name: 'deviceforge-web', version: '0.1.0' },
          'io.modelcontextprotocol/clientCapabilities': {},
        } },
      });
      const response = await abortable(options.transport(endpoint, {
        method: 'POST', headers, signal, redirect: 'error', credentials: 'omit', cache: 'no-store', body,
      }), signal);
      if (signal.aborted) throw cancelled(response.headers.get('x-deviceforge-log-id'));
      return { requestId, response };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (signal.aborted) throw cancelled();
      throw new ApiError('network', 'network_error', '无法取得 MCP 服务响应');
    }
  }
  return { request };
}
