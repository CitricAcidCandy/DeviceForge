import { HostError } from '../../plugin-sdk/index.ts';
import type { Dispose, HostContext, HostResult, JsonValue, ServiceContribution } from '../../plugin-sdk/index.ts';
import type { McpClient, McpSnapshot } from '../../features/mcp/index.ts';
import type { ExtensionRegistry } from '../../plugins/extensions/registry.ts';
import { abortable } from '../../services/api/abort.ts';
import { isJsonData } from '../../shared/jobs/values.ts';
import { publicCall } from '../public-api.ts';
import { productServiceOrigin } from '../product/connection.ts';

export interface PlatformConnection {
  readonly baseUrl: string;
  readonly reconnect?: (
    baseUrl: string, token: string, signal: AbortSignal,
  ) => Promise<void | Pick<HostResult<unknown>, 'logId'>>;
}
export interface PlatformServicesOptions {
  readonly connection?: PlatformConnection;
  readonly mcp?: Pick<McpClient, 'listTools'>;
}
export interface PlatformServiceHost {
  readonly host: HostContext;
  readonly extensions: Pick<ExtensionRegistry, 'register'>;
}
function active(signal: AbortSignal) {
  if (signal.aborted) throw new HostError('cancelled', 'platform_service_revoked', '平台服务调用已撤销');
}
function invalid(): HostError {
  return new HostError('protocol', 'invalid_platform_service_request', '平台服务动作或参数不符合公开契约');
}
function object(value: JsonValue): { [key: string]: JsonValue } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value;
}
function fields(value: { [key: string]: JsonValue }, keys: readonly string[]) {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw invalid();
}
function origin(value: string): string {
  if (!value.trim() || value.length > 2048) throw invalid();
  try { return productServiceOrigin(value); }
  catch { throw new HostError('protocol', 'invalid_connection_address', '服务地址必须是无路径、凭证、查询参数及片段的 HTTP 地址'); }
}
function connectionState(connection: PlatformConnection): JsonValue {
  return { baseUrl: origin(connection.baseUrl), canReconnect: typeof connection.reconnect === 'function' };
}
function mcpResult(snapshot: McpSnapshot): JsonValue {
  if (snapshot.tools.length > 4096)
    throw new HostError('protocol', 'mcp_catalog_too_large', 'MCP 工具目录超过 4096 项', snapshot.logId);
  const tools = snapshot.tools.map((tool) => ({
    name: tool.name, inputSchema: tool.inputSchema,
    ...(tool.title === undefined ? {} : { title: tool.title }),
    ...(tool.description === undefined ? {} : { description: tool.description }),
    ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
    ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
    ...(tool.meta === undefined ? {} : { meta: tool.meta }),
  }));
  const result: unknown = { tools };
  if (!isJsonData(result))
    throw new HostError('protocol', 'invalid_mcp_catalog', 'MCP 工具目录不是有限 JSON 数据', snapshot.logId);
  return structuredClone(result);
}
function connectionService(connection: PlatformConnection): ServiceContribution {
  return {
    id: 'host.connection', version: '1',
    inputSchema: { oneOf: [
      { type: 'object', required: ['action'], additionalProperties: false, properties: { action: { const: 'status' } } },
      { type: 'object', required: ['action', 'baseUrl', 'token'], additionalProperties: false, properties: {
        action: { const: 'reconnect' }, baseUrl: { type: 'string', minLength: 1, maxLength: 2048 },
        token: { type: 'string', maxLength: 16384 },
      } },
    ] },
    outputSchema: { type: 'object', required: ['baseUrl', 'canReconnect'], additionalProperties: false,
      properties: { baseUrl: { type: 'string' }, canReconnect: { type: 'boolean' } } },
    async invoke(value, _context, signal) {
      active(signal);
      const input = object(value);
      if (input.action === 'status') { fields(input, ['action']); return { data: connectionState(connection), logId: null }; }
      if (input.action !== 'reconnect') throw invalid();
      fields(input, ['action', 'baseUrl', 'token']);
      if (typeof input.baseUrl !== 'string' || typeof input.token !== 'string' ||
          input.token.length > 16384 || /[\u0000-\u001f\u007f]/u.test(input.token)) throw invalid();
      const address = origin(input.baseUrl), token = input.token;
      const reconnect = connection.reconnect;
      if (!reconnect) throw new HostError('protocol', 'connection_reconnect_unavailable', '当前连接不支持从插件切换');
      // 只代理原入口一次；结束等待不代表切换回滚，晚到结果不改写当前连接观测。
      return publicCall(abortable(Promise.resolve().then(async () => {
        active(signal);
        const receipt = await reconnect.call(connection, address, token, signal);
        active(signal);
        return { data: connection, logId: receipt ? receipt.logId : null };
      }), signal), connectionState);
    },
  };
}
function mcpService(mcp: Pick<McpClient, 'listTools'>): ServiceContribution {
  return {
    id: 'host.mcp', version: '1',
    inputSchema: { type: 'object', required: ['action'], additionalProperties: false, properties: { action: { const: 'listTools' } } },
    outputSchema: { type: 'object', required: ['tools'], additionalProperties: false, properties: {
      tools: { type: 'array', maxItems: 4096, items: {
        type: 'object', required: ['name', 'inputSchema'], additionalProperties: false,
        properties: { name: { type: 'string', minLength: 1 }, title: { type: 'string' }, description: { type: 'string' },
          inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
          annotations: { type: 'object' }, meta: { type: 'object' } },
      } },
    } },
    async invoke(value, _context, signal) {
      active(signal);
      const input = object(value); fields(input, ['action']);
      if (input.action !== 'listTools') throw invalid();
      return publicCall(abortable(Promise.resolve().then(async () => {
        active(signal);
        const snapshot = await mcp.listTools(signal);
        active(signal);
        return { data: snapshot, logId: snapshot.logId };
      }), signal), mcpResult);
    },
  };
}
/** 注入现有能力并复用同一注册、取消和调用期限；不另建连接或长期 MCP 会话。 */
export function registerPlatformServices(rootHost: PlatformServiceHost, options: PlatformServicesOptions): Dispose {
  active(rootHost.host.signal);
  const services: ServiceContribution[] = [];
  if (options.connection) services.push(connectionService(options.connection));
  if (options.mcp) services.push(mcpService(options.mcp));
  if (!services.length) return () => undefined;
  return rootHost.host.onDispose(rootHost.extensions.register({
    pluginId: 'host', generation: 0, context: rootHost.host,
  }, { services }));
}
