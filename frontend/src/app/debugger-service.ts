import { HostError } from '../plugin-sdk/index.ts';
import type { HostContext, HostResult, JsonValue } from '../plugin-sdk/index.ts';
import { isJsonData } from '../shared/jobs/index.ts';
import { logQueryEndpoint } from '../services/api/index.ts';
import type { ApiClient, DebuggerGateway } from '../services/api/index.ts';
import type { DebuggerBridgeSnapshot } from '../features/debugger/index.ts';

export interface DebuggerPublicOptions {
  readonly context: HostContext;
  readonly client: ApiClient;
  readonly gateway: DebuggerGateway;
  readonly snapshot: () => DebuggerBridgeSnapshot;
  readonly start: () => Promise<void>;
  readonly reconnect: () => Promise<void>;
  readonly installation?: (signal: AbortSignal) => Promise<HostResult<JsonValue>>;
}

export const debuggerInputSchema: JsonValue = {
  type: 'object', required: ['action'], additionalProperties: false,
  properties: {
    action: { enum: ['capabilities', 'status', 'start', 'reconnect', 'call', 'logs', 'installation', 'focus'] },
    name: { type: 'string' }, input: {},
  },
};
function invalid(message: string): never {
  throw new HostError('protocol', 'debugger_invalid_input', message);
}
function object(input: JsonValue | undefined): { [key: string]: JsonValue } {
  if (input === undefined) return {};
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return invalid('调试参数必须是 JSON 对象');
  return input;
}

/** 官方面板和第三方工具消费同一公开服务，不读取宿主内部状态或自行拼接 HTTP。 */
export async function invokeDebuggerPublic(options: DebuggerPublicOptions, request: JsonValue, signal: AbortSignal): Promise<HostResult<JsonValue>> {
  const value = object(request);
  const combined = AbortSignal.any([options.context.signal, signal]);
  combined.throwIfAborted();
  if (value.action === 'capabilities' || value.action === 'status') {
    return { logId: null, data: { protocol_version: 1, stage: 'integration', local_only: true,
      bridge: { ...options.snapshot() }, source_breakpoints: false, arbitrary_evaluation: false,
      production_acceptance_complete: false,
      note: '按当前目标能力执行；完整首期验收结果以随包交付记录为准' } };
  }
  if (value.action === 'start' || value.action === 'reconnect') {
    if (value.action === 'reconnect') {
      if (object(value.input).confirmed !== true) return invalid('重新连接会结束旧浏览器实例的调试会话，请显式确认；不会重放任何动作');
      await options.reconnect();
    } else await options.start();
    combined.throwIfAborted();
    return { logId: null, data: { instance_id: options.snapshot().instanceId, bridge: { ...options.snapshot() } } };
  }
  if (value.action === 'installation') {
    if (!options.installation) throw new HostError('protocol', 'debugger_capability_unavailable', '此宿主没有接入安装构建目录；不能据此认定插件未安装');
    return options.installation(combined);
  }
  if (value.action === 'focus') {
    const input = object(value.input);
    const validTarget = (item: JsonValue | undefined) => item !== null && typeof item === 'object' && !Array.isArray(item) &&
      (item.target_kind === 'browser' || item.target_kind === 'server') &&
      typeof item.plugin_id === 'string' && /^[a-z][a-z0-9._-]{0,99}$/.test(item.plugin_id);
    if (!validTarget(input) && !(Array.isArray(input.candidates) && input.candidates.length > 0 &&
      input.candidates.length <= 64 && input.candidates.every(validTarget)))
      return invalid('请指定浏览器或服务器插件及完整插件 ID');
    const tools = options.context.extensions?.catalog().components.filter(item => item.slot === 'developer.tools');
    if (!tools?.some(item => item.pluginId === 'deviceforge_debugger'))
      throw new HostError('protocol', 'debugger_panel_unavailable', '请先在市场本地导入并启用官方 Debugger 插件，再选择调试目标');
    options.context.extensions?.emitEvent('host.debugger.target_requested', input);
    return { logId: null, data: { requested: true } };
  }
  if (value.action === 'logs') {
    const input = object(value.input);
    if (Object.keys(input).some(key => !['log_id', 'q', 'order'].includes(key)))
      return invalid('该日志搜索入口只支持日志 ID 或关键词及时间排序；请用调试事件工具查询带游标的诊断流');
    if ((input.log_id !== undefined && typeof input.log_id !== 'string') ||
      (input.q !== undefined && typeof input.q !== 'string') ||
      (input.order !== undefined && input.order !== 'asc' && input.order !== 'desc')) return invalid('日志筛选字段类型不正确');
    const response = await options.client.call(logQueryEndpoint, {
      ...(typeof input.log_id === 'string' ? { log_id: input.log_id } : {}),
      ...(typeof input.q === 'string' ? { q: input.q } : {}),
      order: input.order === 'asc' ? 'asc' : 'desc',
    }, combined);
    if (!isJsonData(response.data)) return invalid('服务器日志响应不符合公开 JSON 合同');
    return { data: response.data, logId: response.logId };
  }
  if (value.action !== 'call' || typeof value.name !== 'string' ||
    !/^deviceforge\.debug_(session|targets|inspect|events|ui_tree|ui_query|ui_diff|ui_assert|ui_action|invoke|reload|report)$/.test(value.name) ||
    !isJsonData(value.input)) return invalid('请使用公开调试工具名和对应 JSON 参数；不会执行任意脚本或其他宿主管理工具');
  const response = await options.gateway.call({ name: value.name, input: value.input }, combined);
  return { data: response.data, logId: response.logId };
}
