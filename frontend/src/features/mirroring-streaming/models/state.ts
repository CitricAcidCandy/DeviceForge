import { ApiError } from '../../../shared/api/index.ts';
import type { MirroringStreamAction, MirroringStreamingSnapshot } from '../types/index.ts';

type Lane = 'definitions' | 'observe' | 'input' | 'cancel';
export interface MirroringRequest {
  readonly action: MirroringStreamAction;
  readonly lane: Lane;
  readonly epoch: number | null;
  readonly controller: AbortController;
  readonly signal: AbortSignal;
}
const empty = (): MirroringStreamingSnapshot => Object.freeze({ definitions: null, session: null, cursor: 0, epoch: 0, status: null, video: null, audio: null, packets: 0,
  pendingBytes: 0, inputState: 'unknown', pending: Object.freeze([]), logs: Object.freeze({}), errors: Object.freeze({}) });
export function createMirroringState() {
  let state = empty(); let epoch = 0; let closed = false; let notification = 0;
  const lifetime = new AbortController();
  const active = new Map<Lane, MirroringRequest>();
  const listeners = new Set<(value: MirroringStreamingSnapshot) => void>();
  function assertOpen(): void { if (closed) throw new ApiError('cancelled', 'mirroring_stream_closed', '投屏直播消费已关闭'); }
  const isCurrent = (context: MirroringRequest) => !closed && !context.signal.aborted && (context.epoch === null || context.epoch === epoch) && active.get(context.lane) === context;
  function assertCurrent(context: MirroringRequest, logId: string | null = null): void {
    if (!isCurrent(context)) throw new ApiError('cancelled', 'stale_mirroring_stream', '投屏请求已取消或由新代替换', null, logId);
  }
  function publish(patch: Partial<MirroringStreamingSnapshot>): void {
    state = Object.freeze({ ...state, ...patch, pending: Object.freeze([...active.values()].map((context) => context.action)) });
    const admitted = ++notification;
    for (const listener of [...listeners]) {
      if (admitted !== notification || closed) break;
      if (listeners.has(listener)) { try { listener(state); } catch { } }
    }
  }
  function revoke(lane: Lane): void { const request = active.get(lane); active.delete(lane); request?.controller.abort(); }
  function reset(): void {
    assertOpen(); ++epoch; revoke('observe'); revoke('input'); revoke('cancel');
    state = Object.freeze({ ...empty(), definitions: state.definitions }); publish({});
  }
  return {
    snapshot: () => state,
    assertOpen, assertCurrent, reset,
    begin(action: MirroringStreamAction, signal: AbortSignal): MirroringRequest {
      assertOpen();
      if (signal.aborted) throw new ApiError('cancelled', 'cancelled', '投屏请求等待已取消');
      const lane: Lane = action === 'definitions' ? 'definitions' : action === 'input' || action === 'eof' ? 'input' : action === 'cancel' ? 'cancel' : 'observe';
      if (lane === 'observe' && active.get(lane)?.action === 'output') throw new ApiError('protocol', 'mirroring_output_busy', '请先取消并等待当前输出消费结束，再读取或恢复游标');
      if (lane === 'input' && (active.has(lane) || state.inputState !== 'writable' || state.session?.status === 'stopping' || state.session?.status === 'finished')) throw new ApiError('protocol', 'mirroring_input_unavailable', '投屏控制已关闭或前次交付仍未确认');
      if (lane !== 'definitions' && action !== 'open' && action !== 'resume' && !state.session) throw new ApiError('protocol', 'mirroring_not_selected', '请先打开或恢复投屏直播会话');
      revoke(lane);
      if (action === 'cancel') revoke('input');
      const controller = new AbortController();
      const request: MirroringRequest = Object.freeze({ action, lane, epoch: lane === 'definitions' ? null : epoch, controller, signal: AbortSignal.any([signal, controller.signal, lifetime.signal]) });
      active.set(lane, request);
      const errors = { ...state.errors }; delete errors[action];
      publish({ errors: Object.freeze(errors), logs: Object.freeze({ ...state.logs, [action]: null }), ...(action === 'definitions' ? { definitions: null } : {}), ...(action === 'cancel' ? { inputState: 'uncertain' } : {}) });
      assertCurrent(request); return request;
    },
    update(context: MirroringRequest, patch: Partial<MirroringStreamingSnapshot>, logId: string | null): void {
      assertCurrent(context, logId); publish({ ...patch, logs: Object.freeze({ ...state.logs, [context.action]: logId }) }); assertCurrent(context, logId);
    },
    end(context: MirroringRequest, logId: string | null): void {
      assertCurrent(context, logId); active.delete(context.lane); publish({});
      if (closed || context.signal.aborted || context.epoch !== null && context.epoch !== epoch) throw new ApiError('cancelled', 'stale_mirroring_stream', '投屏请求完成后已撤销', null, logId);
    },
    failure(context: MirroringRequest, error: ApiError): void {
      if (active.get(context.lane) !== context || closed || context.epoch !== null && context.epoch !== epoch) return;
      active.delete(context.lane);
      publish({ errors: Object.freeze({ ...state.errors, [context.action]: error }), logs: Object.freeze({ ...state.logs, [context.action]: error.logId }), ...(context.lane === 'input' ? { inputState: 'uncertain' } : {}) });
    },
    subscribe(listener: (value: MirroringStreamingSnapshot) => void) { assertOpen(); listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() { if (closed) return; closed = true; ++epoch; ++notification; lifetime.abort(); for (const request of active.values()) request.controller.abort(); active.clear(); listeners.clear(); state = empty(); },
  };
}
