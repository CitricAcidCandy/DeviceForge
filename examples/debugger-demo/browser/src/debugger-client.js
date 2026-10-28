import { waitFor } from './echo.js';

// 可在自有开发工具内使用；不会自行连接、选目标、重试或执行变更。
export async function debuggerRequest(context, request, callerSignal) {
  if (!context.extensions) throw new Error('宿主未提供公开扩展服务接口，请使用兼容发行版');
  const longCommand = request.action === 'call' &&
    ['deviceforge.debug_automation_run', 'deviceforge.debug_reload'].includes(request.name);
  const signal = AbortSignal.any([context.signal, callerSignal, AbortSignal.timeout(longCommand ? 35000 : 10000)]);
  signal.throwIfAborted();
  return waitFor(context.extensions.callService('host.debugger', '1', request, signal), signal);
}

export function debuggerTool(context, name, input, signal) {
  return debuggerRequest(context, { action: 'call', name, input }, signal);
}

// 浏览器桥工具返回命令回执；服务器目录、报告和日志等入口直接返回业务对象。
export function confirmedResponse(result) {
  const value = result.data;
  if (value && typeof value === 'object' && typeof value.command_id === 'string') {
    if (value.state !== 'succeeded') {
      const error = new Error(`调试动作未成功确认：${value.state}；请查询状态，不要自动重放`);
      error.logId = result.logId;
      throw error;
    }
    return value.response;
  }
  return value;
}

// 报告续页属于冻结 UI 快照，不能把这些参数再交给 debug_report。
export function snapshotPage(context, sessionId, continuation, signal) {
  return debuggerTool(context, 'deviceforge.debug_ui_tree', {
    session_id: sessionId,
    parameters: { root_id: continuation.root_id, snapshot_id: continuation.snapshot_id,
      offset: continuation.offset, limit: 500 },
  }, signal);
}
