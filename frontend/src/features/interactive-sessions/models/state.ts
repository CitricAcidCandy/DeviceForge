import { ApiError } from '../../../shared/api/index.ts';
import type { SessionOutputPage } from '../../../shared/api/index.ts';
import { mergeInfo } from '../utils/rules.ts';
import type { InteractiveSessionSnapshot, SessionAction, SessionInfoView } from '../types/index.ts';

type Lane = 'definitions' | 'records' | 'observe' | 'input' | 'control';
export interface SessionRequest {
  readonly action: SessionAction;
  readonly lane: Lane;
  readonly epoch: number | null;
  readonly identity: SessionInfoView | null;
  readonly controller: AbortController;
  readonly signal: AbortSignal;
}
const empty = (): InteractiveSessionSnapshot => Object.freeze({ definitions: null, records: Object.freeze([]), session: null, chunks: Object.freeze([]), cursor: 0, inputState: 'unknown', pending: Object.freeze([]), logs: Object.freeze({}), errors: Object.freeze({}) });
const laneFor = (action: SessionAction): Lane => action === 'definitions' || action === 'records' ? action : action === 'input' || action === 'eof' ? 'input' : action === 'cancel' || action === 'remove' ? 'control' : 'observe';
export function createSessionState() {
  let state = empty(); let epoch = 0; let notification = 0; let closed = false; let outputBytes = 0;
  const lifetime = new AbortController();
  const active = new Map<Lane, SessionRequest>();
  const listeners = new Set<(snapshot: InteractiveSessionSnapshot) => void>();
  const assertOpen = () => { if (closed) throw new ApiError('cancelled', 'sessions_closed', '交互会话消费已关闭'); };
  const current = (context: SessionRequest) => !closed && (context.epoch === null || context.epoch === epoch) && active.get(context.lane) === context;
  function assertAlive(context: SessionRequest, logId: string | null = null): void {
    if (closed || context.signal.aborted || context.epoch !== null && context.epoch !== epoch) throw new ApiError('cancelled', 'stale_session_result', '会话请求等待已取消或撤销', null, logId);
  }
  function assertCurrent(context: SessionRequest, logId: string | null = null): void {
    assertAlive(context, logId);
    if (!current(context)) throw new ApiError('cancelled', 'stale_session_result', '会话请求已被更新请求替代', null, logId);
  }
  function publish(patch: Partial<InteractiveSessionSnapshot>): void {
    state = Object.freeze({ ...state, ...patch, pending: Object.freeze([...active.values()].map((context) => context.action)) });
    const admitted = ++notification;
    for (const listener of [...listeners]) {
      if (admitted !== notification || closed) break;
      if (!listeners.has(listener)) continue;
      try { listener(state); } catch { }
    }
  }
  function revoke(lane: Lane): void {
    const context = active.get(lane); active.delete(lane); context?.controller.abort();
  }
  function revokeSelection(): void { revoke('observe'); revoke('input'); revoke('control'); }
  function selectionReset(): void {
    ++epoch; revokeSelection(); outputBytes = 0;
    const logs: InteractiveSessionSnapshot['logs'] = { ...(state.logs.definitions === undefined ? {} : { definitions: state.logs.definitions }), ...(state.logs.records === undefined ? {} : { records: state.logs.records }) };
    state = Object.freeze({ ...state, session: null, chunks: Object.freeze([]), cursor: 0, inputState: 'unknown', logs: Object.freeze(logs), errors: Object.freeze({}) });
  }
  function begin(action: SessionAction, signal: AbortSignal): SessionRequest {
    assertOpen();
    if (signal.aborted) throw new ApiError('cancelled', 'cancelled', '会话请求等待已取消');
    const lane = laneFor(action);
    const replacing = action === 'open' || action === 'resume';
    if (replacing) selectionReset();
    if (lane !== 'definitions' && lane !== 'records' && !replacing && !state.session) throw new ApiError('protocol', 'session_not_selected', '请先打开或恢复已有会话');
    if (lane === 'input') {
      if (active.has(lane)) throw new ApiError('protocol', 'session_input_busy', '上一项输入或EOF仍在等待收据');
      if (state.session?.status === 'stopping' || state.session?.status === 'finished' || state.inputState === 'eof' || state.inputState === 'uncertain' || state.inputState === 'eof_pending') throw new ApiError('protocol', 'session_input_closed', '会话已停止输入或前次交付未确认');
    }
    if (action === 'remove' && state.session?.status !== 'finished') throw new ApiError('protocol', 'session_not_finished', '只能删除已观察到Finished的会话记录');
    revoke(lane);
    if (action === 'cancel' || action === 'remove') revoke('input');
    if (action === 'remove') revoke('observe');
    const controller = new AbortController();
    const context = Object.freeze({ action, lane, epoch: lane === 'definitions' || lane === 'records' ? null : epoch, identity: state.session, controller, signal: AbortSignal.any([signal, controller.signal, lifetime.signal]) });
    active.set(lane, context);
    const errors = { ...state.errors }; delete errors[action];
    publish({ logs: Object.freeze({ ...state.logs, [action]: null }), errors: Object.freeze(errors), ...(action === 'definitions' ? { definitions: null } : {}), ...(action === 'records' ? { records: Object.freeze([]) } : {}), ...(action === 'eof' ? { inputState: 'eof_pending' } : {}), ...(action === 'cancel' ? { inputState: 'uncertain' } : {}) });
    assertCurrent(context);
    return context;
  }
  function update(context: SessionRequest, patch: Partial<InteractiveSessionSnapshot>, logId: string | null): void {
    assertCurrent(context, logId);
    publish({ ...patch, logs: Object.freeze({ ...state.logs, [context.action]: logId }) });
    assertCurrent(context, logId);
  }
  function observe(context: SessionRequest, session: SessionInfoView, logId: string | null, page?: SessionOutputPage): void {
    const merged = mergeInfo(state.session, session);
    let patch: Partial<InteractiveSessionSnapshot> = { session: merged };
    if (merged.status === 'stopping' || merged.status === 'finished') {
      revoke('input');
      patch = { ...patch, inputState: state.inputState === 'eof' ? 'eof' : 'uncertain' };
    }
    if (page) {
      const bytes = page.chunks.reduce((sum, chunk) => sum + chunk.bytes.length, 0);
      if (outputBytes + bytes > 16 * 1024 * 1024 || state.chunks.length + page.chunks.length > 65536) throw new ApiError('protocol', 'session_output_limit', '会话输出超过公开保留限额', null, logId);
      outputBytes += bytes;
      patch = { ...patch, chunks: Object.freeze([...state.chunks, ...page.chunks]), cursor: page.next_sequence };
    }
    update(context, patch, logId);
  }
  return {
    snapshot: () => state,
    begin, assertCurrent, assertAlive, update, observe,
    end(context: SessionRequest) {
      if (!current(context)) return;
      active.delete(context.lane); publish({});
    },
    failure(context: SessionRequest, error: ApiError) {
      if (!current(context)) return;
      active.delete(context.lane);
      publish({ errors: Object.freeze({ ...state.errors, [context.action]: error }), logs: Object.freeze({ ...state.logs, [context.action]: error.logId }), ...(context.lane === 'input' ? { inputState: 'uncertain' } : {}) });
    },
    clear() { assertOpen(); selectionReset(); publish({}); },
    subscribe(listener: (snapshot: InteractiveSessionSnapshot) => void) { assertOpen(); listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() {
      if (closed) return;
      closed = true; ++epoch; ++notification; lifetime.abort();
      for (const context of active.values()) context.controller.abort();
      active.clear(); listeners.clear(); outputBytes = 0; state = empty();
    },
  };
}
