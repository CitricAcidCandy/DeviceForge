import { ApiError } from '../../../shared/api/index.ts';
import { abortable } from '../../../shared/api/abort.ts';
import type { McpTransport } from '../../../shared/api/index.ts';
import { readSse } from './sse.ts';
import { decodeAcknowledgement, decodeNotification, decodeRpc, decodeToolsPage } from './protocol.ts';
import type { McpClient, McpSnapshot, McpSubscriptionHandlers, McpTool } from '../domain/types.ts';

interface Subscription {
  readonly controller: AbortController;
  readonly finished: Promise<void>;
}

function cancelled(message = 'MCP 客户端已关闭'): ApiError {
  return new ApiError('cancelled', 'cancelled', message);
}
function asError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError('network', 'mcp_subscription_failed', 'MCP 目录订阅失败');
}
function parseEvent(value: string): unknown {
  try { const parsed: unknown = JSON.parse(value); return parsed; }
  catch { throw new ApiError('protocol', 'invalid_sse_json', 'MCP SSE 数据不是有效 JSON'); }
}

export function createMcpClient(transport: McpTransport): McpClient {
  const lifetime = new AbortController();
  const subscriptions = new Set<Subscription>();
  let closed = false;
  let requestEpoch = 0;
  let version = 0;
  let current: McpSnapshot = Object.freeze({ tools: Object.freeze([]), logId: null, version });
  function ensureOpen() {
    if (closed) throw cancelled();
  }
  function active(signal: AbortSignal, epoch: number): void {
    if (signal.aborted) throw cancelled('MCP 目录请求等待已取消');
    if (closed || epoch !== requestEpoch) throw new ApiError('cancelled', 'stale_result', '旧 MCP 工具目录响应已撤销');
  }
  async function listTools(signal: AbortSignal): Promise<McpSnapshot> {
    ensureOpen();
    const epoch = ++requestEpoch;
    const combined = AbortSignal.any([signal, lifetime.signal]);
    if (combined.aborted) throw cancelled('MCP 目录请求等待已取消');
    const tools: McpTool[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let logId: string | null = null;
    let pages = 0;
    do {
      active(combined, epoch);
      const params: Readonly<Record<string, unknown>> = cursor === undefined ? {} : { cursor };
      const page = await decodeToolsPage(await abortable(transport.request('tools/list', params, combined), combined), combined);
      active(combined, epoch);
      tools.push(...page.tools);
      if (page.logId) logId = page.logId;
      cursor = page.nextCursor;
      if (cursor !== undefined) {
        if (cursors.has(cursor)) throw new ApiError('protocol', 'invalid_mcp_cursor', 'MCP 工具目录游标重复');
        cursors.add(cursor);
      }
      pages += 1;
      if (pages > 10000) throw new ApiError('protocol', 'mcp_catalog_too_large', 'MCP 工具目录分页超过上限');
    } while (cursor !== undefined);
    active(combined, epoch);
    current = Object.freeze({ tools: Object.freeze(tools), logId, version: ++version });
    return current;
  }
  async function subscribe(handlers: McpSubscriptionHandlers, signal: AbortSignal): Promise<() => Promise<void>> {
    ensureOpen();
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal, lifetime.signal]);
    let finish: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const subscription: Subscription = { controller, finished };
    subscriptions.add(subscription);
    try {
      const reply = await abortable(transport.request('subscriptions/listen', { notifications: { toolsListChanged: true } }, combined), combined);
      if (combined.aborted) throw cancelled('MCP 订阅等待已取消');
      const contentType = reply.response.headers.get('content-type') ?? '';
      if (!reply.response.ok) {
        await decodeRpc(reply, combined);
      }
      if (!contentType.toLowerCase().startsWith('text/event-stream')) {
        throw new ApiError('protocol', 'invalid_mcp_subscription', 'MCP 订阅响应不是 SSE 流', reply.response.status, reply.response.headers.get('x-deviceforge-log-id'));
      }
      const stream = readSse(reply.response, combined);
      const first = await stream.next();
      if (first.done) throw new ApiError('protocol', 'invalid_mcp_subscription', 'MCP 订阅缺少确认帧');
      decodeAcknowledgement(parseEvent(first.value));
      const run = async () => {
        let refreshQueue = Promise.resolve();
        try {
          for await (const raw of stream) {
            if (combined.aborted) return;
            const notification = parseEvent(raw);
            decodeNotification(notification, reply.response.headers.get('x-deviceforge-log-id'));
            refreshQueue = refreshQueue.then(async () => {
              if (combined.aborted) return;
              const snapshot = await listTools(combined);
              if (!combined.aborted) handlers.changed(snapshot);
            });
            await refreshQueue;
          }
          if (!combined.aborted) throw new ApiError('network', 'mcp_subscription_closed', 'MCP 目录订阅流意外结束');
        } catch (error) {
          if (!combined.aborted) handlers.error?.(asError(error));
        } finally {
          finish(); subscriptions.delete(subscription);
        }
      };
      void run();
      return async () => { controller.abort(); await finished; };
    } catch (error) {
      controller.abort(); subscriptions.delete(subscription); finish();
      throw error;
    }
  }
  return {
    listTools,
    subscribe,
    snapshot: () => current,
    async dispose() {
      if (closed) return;
      closed = true; lifetime.abort();
      for (const item of subscriptions) item.controller.abort();
      await Promise.all([...subscriptions].map((item) => item.finished));
      subscriptions.clear();
    },
  };
}
