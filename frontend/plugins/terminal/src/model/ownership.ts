import type { CleanupContext } from '@deviceforge/plugin-sdk';
import { abortable, apiError, ApiError } from '@deviceforge/business-kit/api';
import { createSessionGateway } from './gateway.ts';
import { decodeInfo } from './utils/rules.ts';
import { waitForPoll } from './models/polling.ts';
import type { SessionInfoView } from './types/index.ts';

/** 只记本实例收到成功打开回执的资源，恢复或列出的他人会话不自动取得归属。 */
export function createTerminalOwnership() {
  const owned = new Map<string, SessionInfoView>();
  let closing = false;
  function record(session: SessionInfoView) {
    if (closing) throw new ApiError('cancelled', 'terminal_closed', '终端实例已进入清理');
    if (session.operation !== 'plugin.terminal.open' || session.plugin_id !== 'terminal')
      throw new ApiError('protocol', 'not_terminal_record', '终端实例不能取得其他插件会话的归属');
    const previous = owned.get(session.id);
    if (previous) decodeInfo(session, null, previous);
    owned.set(session.id, session);
  }
  function observe(session: SessionInfoView | null) {
    if (!session) return;
    const previous = owned.get(session.id);
    if (!previous) return;
    decodeInfo(session, null, previous);
    owned.set(session.id, session);
  }
  async function release(cleanup: CleanupContext): Promise<void> {
    closing = true;
    if (owned.size === 0) return;
    if (!cleanup.transport)
      throw new ApiError('protocol', 'cleanup_transport_unavailable', '宿主没有提供终端清理请求能力');
    const remaining = Math.min(5000, cleanup.deadline - Date.now());
    if (remaining <= 0)
      throw new ApiError('cancelled', 'terminal_cleanup_timeout', '终端释放已超过本次清理截止点');
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), remaining);
    const signal = AbortSignal.any([cleanup.signal, deadline.signal]);
    const gateway = createSessionGateway(cleanup.transport);
    async function one(identity: SessionInfoView) {
      let lastLog: string | null = null;
      try {
        const observed = await abortable(gateway.get(identity.id, signal), signal);
        lastLog = observed.logId;
        let session = decodeInfo(observed.data, observed.logId, identity);
        if (session.status === 'opening' || session.status === 'running') {
          const released = await abortable(gateway.release(identity.id, signal), signal);
          lastLog = released.logId;
          session = decodeInfo(released.data, released.logId, identity);
          if (session.status !== 'stopping' && session.status !== 'finished')
            throw new ApiError('protocol', 'invalid_session_release', '释放未返回关闭中或已结束', null, lastLog);
        }
        // 已派发的释放只读查询，不重放；Stopping 不能作为清理完成证据。
        while (session.status !== 'finished') {
          await waitForPoll(100, signal);
          const result = await abortable(gateway.get(identity.id, signal), signal);
          lastLog = result.logId;
          session = decodeInfo(result.data, result.logId, identity);
        }
        if (session.completion?.cleanup !== 'complete' || !session.completion.process_exited)
          throw new ApiError('protocol', 'terminal_cleanup_unconfirmed', '终端已结束，但资源清理尚未确认', null, lastLog);
        owned.delete(identity.id);
      } catch (error) {
        const failure = apiError(error);
        if (signal.aborted)
          throw new ApiError('cancelled', 'terminal_cleanup_timeout', '终端释放未在截止点内确认，请按原记录查询', null,
            failure instanceof ApiError ? failure.logId ?? lastLog : lastLog);
        throw failure;
      }
    }
    try {
      const results = await Promise.allSettled([...owned.values()].map(one));
      const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length === 1) throw failures[0];
      if (failures.length) throw new AggregateError(failures, '部分本实例终端释放未确认');
    } finally { clearTimeout(timer); }
  }
  return {
    record, observe, release,
    forget: (id: string) => { owned.delete(id); },
    snapshot: () => Object.freeze([...owned.values()]),
  };
}
