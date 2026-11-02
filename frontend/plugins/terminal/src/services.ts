import type { HostContext } from '@deviceforge/plugin-sdk';
import { abortable, apiError, ApiError, isRecord } from '@deviceforge/business-kit/api';
import {
  createInteractiveSessions, createSessionGateway,
} from './model/index.ts';
import { decodeInfo, decodeRemoved } from './model/utils/rules.ts';
import { createTerminalOwnership } from './model/ownership.ts';
import type { InteractiveSessionOptions } from './model/index.ts';

export function createTerminalServices(context: HostContext, options: InteractiveSessionOptions = {}) {
  const transport = context.transport, registerCleanup = context.onCleanup;
  if (!transport || !registerCleanup)
    throw new Error('终端需要公开通信和有界清理能力，请升级宿主；不会接管旧终端页面');
  const ownership = createTerminalOwnership();
  const gateway = createSessionGateway(transport);
  let closed = false;
  const sessions = createInteractiveSessions({
    ...gateway,
    async open(input, signal) {
      const result = await gateway.open(input, signal);
      const session = decodeInfo(result.data, result.logId);
      if (session.operation !== 'plugin.terminal.open' || session.plugin_id !== 'terminal' ||
          session.status !== 'opening' || session.output_sequence !== 0)
        throw new ApiError('protocol', 'invalid_session_open', '打开回执不属于本次终端请求', null, result.logId);
      if (signal.aborted)
        throw new ApiError('cancelled', 'terminal_open_unknown', '打开回执已撤销，请按原服务器记录查询', null, result.logId);
      ownership.record(session);
      return result;
    },
    async remove(id, signal) {
      const result = await gateway.remove(id, signal);
      decodeRemoved(result.data, id, result.logId);
      ownership.forget(id);
      return result;
    },
  }, options);
  const unsubscribe = sessions.subscribe((snapshot) => ownership.observe(snapshot.session));
  const release = registerCleanup(async (cleanup) => {
    closed = true;
    unsubscribe();
    sessions.dispose();
    await ownership.release(cleanup);
  });
  let closing: Promise<void> | null = null;
  const draft: { profile: string | null; raw: boolean } = { profile: null, raw: false };
  return {
    context, sessions, draft,
    async readProfiles(signal: AbortSignal) {
      if (closed) throw new ApiError('cancelled', 'terminal_closed', '终端实例已关闭');
      try {
        const result = await abortable(transport.request({
          path: '/api/v2/plugin-configurations/server/terminal',
        }, signal), signal);
        if (!isRecord(result.data) || result.data.kind !== 'server' ||
            result.data.id !== 'terminal' || !isRecord(result.data.values))
          throw new ApiError('protocol', 'invalid_terminal_profiles', '终端配置响应无效', null, result.logId);
        return { values: result.data.values, logId: result.logId };
      } catch (error) { throw apiError(error); }
    },
    owned: ownership.snapshot,
    dispose(): Promise<void> {
      if (!closing) {
        closed = true;
        unsubscribe();
        sessions.dispose();
        closing = (async () => { await release(); })();
      }
      return closing;
    },
  };
}
export type TerminalServices = ReturnType<typeof createTerminalServices>;
export type TerminalSessions = TerminalServices['sessions'];
