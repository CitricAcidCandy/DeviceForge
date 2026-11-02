import { HostError } from '@deviceforge/plugin-sdk';
import type { HostContext, JsonValue } from '@deviceforge/plugin-sdk';
import { jsonObject } from './model/json.ts';

export const SETTINGS_CONNECTION_SERVICE = { id: 'host.connection', version: '1' };
export const SETTINGS_MCP_SERVICE = { id: 'host.mcp', version: '1' };
export const MARKETPLACE_PREFERENCES_SERVICE = { id: 'deviceforge_marketplace.preferences', version: '1' };
export interface ConnectionState { readonly baseUrl: string; readonly canReconnect: boolean }
export interface McpTool {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: JsonValue;
}
export function connectionState(value: JsonValue): ConnectionState {
  if (!jsonObject(value) || typeof value.baseUrl !== 'string' || typeof value.canReconnect !== 'boolean')
    throw new HostError('protocol', 'invalid_connection_status', '平台连接状态不兼容');
  const url = new URL(value.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new HostError('protocol', 'invalid_connection_status', '平台连接地址无效');
  return { baseUrl: url.origin, canReconnect: value.canReconnect };
}
export function mcpTools(value: JsonValue): readonly McpTool[] {
  if (!jsonObject(value) || !Array.isArray(value.tools) || value.tools.length > 4096)
    throw new HostError('protocol', 'invalid_mcp_tools', 'MCP 工具目录不兼容');
  return value.tools.map((item) => {
    if (!jsonObject(item) || typeof item.name !== 'string' || !item.name ||
        item.inputSchema === undefined || !jsonObject(item.inputSchema) ||
        (item.title !== undefined && typeof item.title !== 'string') ||
        (item.description !== undefined && typeof item.description !== 'string'))
      throw new HostError('protocol', 'invalid_mcp_tools', 'MCP 工具字段不兼容');
    return {
      name: item.name, inputSchema: item.inputSchema,
      ...(typeof item.title === 'string' ? { title: item.title } : {}),
      ...(typeof item.description === 'string' ? { description: item.description } : {}),
    };
  });
}
export function platformCall(context: HostContext, ref: { id: string; version: string }, value: JsonValue, signal: AbortSignal) {
  if (!context.services) throw new HostError('protocol', 'platform_service_unavailable', '宿主尚未提供对应公开平台服务');
  return context.services.call(ref, value, signal);
}
export function marketAddress(value: JsonValue): string {
  if (!jsonObject(value) || typeof value.url !== 'string')
    throw new HostError('protocol', 'invalid_market_preferences', '市场地址响应不兼容');
  const url = new URL(value.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new HostError('protocol', 'invalid_market_preferences', '市场地址响应无效');
  return url.toString().replace(/\/$/, '');
}
