import { ApiError } from '../../../services/api/index.ts';
import type { SessionInfo } from '../../../services/api/index.ts';
import { AiSdkStreamDecoder } from '../services/decoder.ts';
import { copyFrozen, invalidStream } from '../utils/rules.ts';
import type { AiSdkStreamAction, AiSdkStreamingSnapshot, AiSdkStreamOwner } from '../types/index.ts';

interface RequestContext {
  readonly action: AiSdkStreamAction;
  readonly lane: string;
  readonly epoch: number;
  readonly controller: AbortController;
  readonly signal: AbortSignal;
  readonly identity: Readonly<SessionInfo> | null;
  logId: string | null;
}
const rank = { opening: 0, running: 1, stopping: 2, finished: 3 };
export function createAiSdkStreamState() {
  let disposed = false;
  let epoch = 0;
  let revision = 0;
  let decoder = new AiSdkStreamDecoder(null);
  let value: AiSdkStreamingSnapshot = Object.freeze({ definitions: null, records: Object.freeze([]), session: null, owner: null,
    stream: decoder.snapshot(), result: null, terminalError: null, pending: Object.freeze([]), logs: Object.freeze({}), errors: Object.freeze({}) });
  const active = new Map<string, RequestContext>();
  const listeners = new Set<(snapshot: AiSdkStreamingSnapshot) => void>();
  function publish(changes: Partial<AiSdkStreamingSnapshot> = {}): void {
    value = Object.freeze({ ...value, ...changes, pending: Object.freeze(Array.from(active.values(), (context) => context.action)) });
    const currentRevision = ++revision;
    const snapshot = value;
    for (const listener of Array.from(listeners)) {
      if (disposed || revision !== currentRevision) break;
      if (listeners.has(listener)) { try { listener(snapshot); } catch {} }
    }
  }
  function alive(logId: string | null = null): void {
    if (disposed) throw new ApiError('cancelled', 'ai_sdk_stream_disposed', 'SDK实时会话消费已销毁', null, logId);
  }
  function current(context: RequestContext): boolean {
    return !disposed && active.get(context.lane) === context && (context.lane === 'definitions' || context.lane === 'records' || context.epoch === epoch);
  }
  function assertCurrent(context: RequestContext, logId: string | null = null): void {
    if (!current(context) || context.signal.aborted) throw new ApiError('cancelled', 'cancelled', 'SDK实时会话请求等待已取消', null, logId);
  }
  function stop(lane: string): void {
    const context = active.get(lane); active.delete(lane); context?.controller.abort();
  }
  function reset(owner: AiSdkStreamOwner | null, newThread = false): void {
    epoch++; stop('selection'); stop('observation'); stop('control');
    decoder = new AiSdkStreamDecoder(owner?.thread_id ?? null, newThread);
    const logs = { ...value.logs }; const errors = { ...value.errors };
    const actions: readonly AiSdkStreamAction[] = ['open', 'resume', 'query', 'output', 'cancel'];
    for (const action of actions) { delete logs[action]; delete errors[action]; }
    value = Object.freeze({ ...value, session: null, owner, stream: decoder.snapshot(), result: null, terminalError: null,
      logs: Object.freeze(logs), errors: Object.freeze(errors) });
  }
  function begin(action: AiSdkStreamAction, signal: AbortSignal, selection?: { readonly owner: AiSdkStreamOwner; readonly resumeId?: string }): RequestContext {
    alive();
    if (signal.aborted) throw new ApiError('cancelled', 'cancelled', 'SDK实时会话请求等待已取消');
    if (selection) {
      const same = selection.resumeId !== undefined && selection.resumeId === value.session?.id;
      if (same) {
        if (selection.owner.project_id !== value.owner?.project_id || selection.owner.thread_id !== undefined
          && selection.owner.thread_id !== (decoder.snapshot().threadId ?? value.owner?.thread_id)) throw invalidStream(null);
        epoch++; stop('selection'); stop('observation'); stop('control');
      } else reset(selection.owner, action === 'open' && selection.owner.thread_id === undefined);
    }
    const lane = action === 'definitions' || action === 'records' ? action : action === 'open' || action === 'resume' ? 'selection' : action === 'cancel' ? 'control' : 'observation';
    if (lane === 'observation' || lane === 'control') {
      if (!value.session) throw new ApiError('protocol', 'ai_sdk_session_not_selected', '请先打开或恢复SDK实时会话');
      if (active.has('selection')) throw new ApiError('protocol', 'ai_sdk_selection_pending', 'SDK会话选择尚未取得响应');
    }
    stop(lane);
    const controller = new AbortController();
    const context: RequestContext = { action, lane, epoch, controller, signal: AbortSignal.any([signal, controller.signal]), identity: value.session, logId: value.logs[action] ?? null };
    active.set(lane, context);
    const errors = { ...value.errors }; delete errors[action];
    publish({ ...(action === 'definitions' ? { definitions: null } : {}), ...(action === 'records' ? { records: Object.freeze([]) } : {}), errors: Object.freeze(errors) });
    return context;
  }
  function update(context: RequestContext, changes: Partial<AiSdkStreamingSnapshot>, logId: string | null): void {
    assertCurrent(context, logId);
    publish({ ...changes, logs: Object.freeze({ ...value.logs, [context.action]: logId }) });
    assertCurrent(context, logId);
  }
  function settle(session: Readonly<SessionInfo>, logId: string | null) {
    if (session.status !== 'finished' || decoder.snapshot().cursor !== session.output_sequence) return { result: value.result, terminalError: value.terminalError };
    const completion = session.completion;
    const outcome = completion?.outcome;
    if (!completion || completion.cleanup !== 'complete' || !completion.process_exited || completion.failure !== null && completion.failure !== undefined
      || !outcome || outcome.error !== null && outcome.error !== undefined || outcome.artifacts.length > 0) {
      decoder.discardTail();
      return { result: null, terminalError: Object.freeze(new ApiError('protocol', 'ai_sdk_stream_failed', 'SDK实时轮次失败或完整资源范围清理未确认', null, logId)) };
    }
    try {
      if (!value.owner) throw invalidStream(logId);
      return { result: decoder.complete(outcome.result, value.owner.project_id, logId), terminalError: null };
    } catch (error) {
      return { result: null, terminalError: error instanceof ApiError ? Object.freeze(error) : Object.freeze(invalidStream(logId)) };
    }
  }
  function observe(context: RequestContext, incoming: SessionInfo, logId: string | null, nextDecoder?: AiSdkStreamDecoder): void {
    assertCurrent(context, logId);
    const previous = value.session;
    if (previous?.status === 'finished' && (incoming.output_sequence > previous.output_sequence || incoming.status === 'finished'
      && (incoming.output_sequence !== previous.output_sequence || JSON.stringify(incoming.completion) !== JSON.stringify(previous.completion)))) throw invalidStream(logId);
    if (incoming.status === 'finished' && previous !== null && incoming.output_sequence < previous.output_sequence) throw invalidStream(logId);
    const session = previous !== null && rank[incoming.status] < rank[previous.status]
      ? copyFrozen({ ...previous, output_sequence: Math.max(previous.output_sequence, incoming.output_sequence) })
      : copyFrozen({ ...incoming, output_sequence: Math.max(previous?.output_sequence ?? 0, incoming.output_sequence) });
    if (nextDecoder) decoder = nextDecoder;
    const terminal = settle(session, logId);
    update(context, { session, stream: decoder.snapshot(), ...terminal }, logId);
  }
  function end(context: RequestContext): void {
    assertCurrent(context); active.delete(context.lane); publish(); alive();
    if (context.epoch !== epoch && context.lane !== 'definitions' && context.lane !== 'records') throw new ApiError('cancelled', 'cancelled', 'SDK会话选择已变更');
  }
  function failure(context: RequestContext, error: ApiError): void {
    if (!current(context)) return;
    active.delete(context.lane);
    publish({ logs: Object.freeze({ ...value.logs, [context.action]: error.logId ?? value.logs[context.action] ?? null }),
      errors: Object.freeze({ ...value.errors, [context.action]: Object.freeze(error) }) });
  }
  return {
    begin, assertCurrent, update, observe, end, failure,
    decoder: () => decoder,
    snapshot: () => value,
    subscribe(listener: (snapshot: AiSdkStreamingSnapshot) => void) {
      alive(); listeners.add(listener); try { listener(value); } catch {}
      return () => { listeners.delete(listener); };
    },
    clear() { alive(); reset(null); publish(); },
    dispose() {
      if (disposed) return;
      disposed = true; epoch++;
      for (const lane of Array.from(active.keys())) stop(lane);
      value = Object.freeze({ ...value, pending: Object.freeze([]) }); listeners.clear();
    },
  };
}
export type AiSdkStreamRequest = ReturnType<ReturnType<typeof createAiSdkStreamState>['begin']>;
