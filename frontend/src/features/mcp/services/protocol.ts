import { abortable } from '../../../shared/api/abort.ts';
import { ApiError } from '../../../shared/api/index.ts';
import type { McpHttpResponse } from '../../../shared/api/index.ts';
import type { McpJsonObject, McpJsonValue, McpTool } from '../types/index.ts';

export interface McpListPage {
  readonly tools: readonly McpTool[];
  readonly nextCursor?: string;
  readonly logId: string | null;
}

interface RpcReply {
  readonly result: Record<string, unknown>;
  readonly logId: string | null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function protocol(message: string, status: number | null = null, logId: string | null = null): ApiError {
  return new ApiError('protocol', 'invalid_mcp_response', message, status, logId);
}
function safeLog(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}
function logFromMeta(meta: unknown): string | null {
  return record(meta) ? safeLog(meta['deviceforge/log_id']) : null;
}
function cloneJson(value: unknown): McpJsonValue | null {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    const copy: McpJsonValue[] = [];
    for (const item of value) {
      const cloned = cloneJson(item);
      if (cloned === null && item !== null) return null;
      copy.push(cloned);
    }
    return Object.freeze(copy);
  }
  if (!record(value)) return null;
  const copy: Record<string, McpJsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    const cloned = cloneJson(item);
    if (cloned === null && item !== null) return null;
    copy[key] = cloned;
  }
  return Object.freeze(copy);
}
function jsonObject(value: McpJsonValue): value is McpJsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function objectSchema(value: unknown): McpJsonObject | null {
  const cloned = cloneJson(value);
  return cloned !== null && jsonObject(cloned) ? cloned : null;
}
function keysAllowed(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const accepted = new Set(allowed);
  return Object.keys(value).every((key) => accepted.has(key));
}
function tool(value: unknown): McpTool | null {
  if (!record(value) || !keysAllowed(value, ['name', 'title', 'description', 'inputSchema', 'outputSchema', 'annotations', '_meta'])) return null;
  const inputSchema = objectSchema(value.inputSchema);
  if (typeof value.name !== 'string' || !value.name || !inputSchema) return null;
  if (value.title !== undefined && typeof value.title !== 'string') return null;
  if (value.description !== undefined && typeof value.description !== 'string') return null;
  const outputSchema = value.outputSchema === undefined ? undefined : objectSchema(value.outputSchema);
  const annotations = value.annotations === undefined ? undefined : objectSchema(value.annotations);
  const meta = value._meta === undefined ? undefined : objectSchema(value._meta);
  if ((value.outputSchema !== undefined && !outputSchema) || (value.annotations !== undefined && !annotations) || (value._meta !== undefined && !meta)) return null;
  return Object.freeze({
    name: value.name,
    ...(value.title === undefined ? {} : { title: value.title }),
    ...(value.description === undefined ? {} : { description: value.description }),
    inputSchema,
    ...(outputSchema ? { outputSchema } : {}),
    ...(annotations ? { annotations } : {}),
    ...(meta ? { meta } : {}),
  });
}

async function parseJson(response: Response, signal: AbortSignal): Promise<unknown> {
  try {
    const text = await abortable(response.text(), signal);
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (signal.aborted) throw new ApiError('cancelled', 'cancelled', 'MCP 响应读取已取消');
    throw protocol('MCP 响应不是有效 JSON', response.status, response.headers.get('x-deviceforge-log-id'));
  }
}

export async function decodeRpc(reply: McpHttpResponse, signal: AbortSignal): Promise<RpcReply> {
  const value = await parseJson(reply.response, signal);
  if (!record(value) || value.jsonrpc !== '2.0' || value.id !== reply.requestId) throw protocol('MCP JSON-RPC 响应身份无效', reply.response.status);
  const headerLogId = safeLog(reply.response.headers.get('x-deviceforge-log-id'));
  if (record(value.error)) {
    const data = value.error.data;
    const bodyLogId = record(data) ? safeLog(data['log_id']) : null;
    if (headerLogId && bodyLogId && headerLogId !== bodyLogId) throw protocol('MCP 错误日志 ID 不一致', reply.response.status, bodyLogId);
    if (typeof value.error.code !== 'number' || !Number.isSafeInteger(value.error.code) || typeof value.error.message !== 'string') throw protocol('MCP JSON-RPC 错误结构无效', reply.response.status, headerLogId ?? bodyLogId);
    throw new ApiError(reply.response.ok ? 'protocol' : 'http', `mcp_${value.error.code}`, value.error.message, reply.response.status, headerLogId ?? bodyLogId);
  }
  if (!reply.response.ok || !record(value.result)) throw protocol('MCP JSON-RPC 成功结构无效', reply.response.status, headerLogId);
  const resultLogId = logFromMeta(value.result['_meta']);
  if (headerLogId && resultLogId && headerLogId !== resultLogId) throw protocol('MCP 成功日志 ID 不一致', reply.response.status, resultLogId);
  return { result: value.result, logId: headerLogId ?? resultLogId };
}

export async function decodeToolsPage(reply: McpHttpResponse, signal: AbortSignal): Promise<McpListPage> {
  const decoded = await decodeRpc(reply, signal);
  if (!keysAllowed(decoded.result, ['tools', 'nextCursor', 'ttlMs', 'cacheScope', 'resultType', '_meta'])) throw protocol('MCP 工具目录包含未知字段', reply.response.status, decoded.logId);
  if (decoded.result.resultType !== undefined && decoded.result.resultType !== 'complete') throw protocol('MCP 工具目录结果类型无效', reply.response.status, decoded.logId);
  if (!Array.isArray(decoded.result.tools)) throw protocol('MCP 工具目录缺少 tools', reply.response.status, decoded.logId);
  const tools = decoded.result.tools.map(tool);
  if (!tools.every((item): item is McpTool => item !== null)) throw protocol('MCP 工具目录包含无效工具', reply.response.status, decoded.logId);
  if (decoded.result.nextCursor !== undefined && typeof decoded.result.nextCursor !== 'string') throw protocol('MCP 工具目录游标无效', reply.response.status, decoded.logId);
  const ttlMs = decoded.result.ttlMs;
  if (ttlMs !== undefined && (typeof ttlMs !== 'number' || !Number.isSafeInteger(ttlMs) || ttlMs < 0)) throw protocol('MCP 工具目录缓存时间无效', reply.response.status, decoded.logId);
  if (decoded.result.cacheScope !== undefined && decoded.result.cacheScope !== 'private' && decoded.result.cacheScope !== 'global') throw protocol('MCP 工具目录缓存范围无效', reply.response.status, decoded.logId);
  if (decoded.result['_meta'] !== undefined && !record(decoded.result['_meta'])) throw protocol('MCP 工具目录元数据无效', reply.response.status, decoded.logId);
  return { tools, ...(decoded.result.nextCursor === undefined ? {} : { nextCursor: decoded.result.nextCursor }), logId: decoded.logId };
}

export function decodeNotification(value: unknown, expectedLogId: string | null): void {
  if (!record(value) || value.jsonrpc !== '2.0' || value.method !== 'notifications/tools/list_changed' || !record(value.params)) throw protocol('MCP 工具目录通知结构无效');
  const meta = value.params['_meta'];
  if (!record(meta) || typeof meta['deviceforge/log_id'] !== 'string' || !meta['deviceforge/log_id'].trim()) throw protocol('MCP 工具目录通知缺少日志 ID');
  if (expectedLogId && meta['deviceforge/log_id'] !== expectedLogId) throw protocol('MCP 工具目录通知日志 ID 不一致', null, expectedLogId);
}

export function decodeAcknowledgement(value: unknown): void {
  if (!record(value) || value.jsonrpc !== '2.0' || value.method !== 'notifications/subscriptions/acknowledged' || !record(value.params)) throw protocol('MCP 订阅确认结构无效');
  const notifications = value.params.notifications;
  if (!record(notifications) || notifications.toolsListChanged !== true) throw protocol('MCP 订阅未确认 toolsListChanged');
}
