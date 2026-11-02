import type { Dispose, HostContext, Job } from '@deviceforge/plugin-sdk';
import { abortable, apiError } from '@deviceforge/business-kit/api';
import { createJobRunner, JobFailure, requireJson } from '@deviceforge/business-kit/jobs';
import type { JobOptions, JobTicket, JsonData } from '@deviceforge/business-kit/jobs';
import type { OperationSource } from '@deviceforge/business-kit/platform';
import { actionInput, deviceActionReason } from './action-rules.ts';
import type { DeviceActionRequest } from './action-rules.ts';

export interface DeviceActionState {
  readonly phase: 'idle' | 'submitting' | 'waiting' | 'succeeded' | 'failed' | 'unknown';
  readonly pending: boolean;
  readonly ticket: JobTicket | null;
  readonly job: Job | null;
  readonly result: JsonData;
  readonly message: string | null;
  readonly logId: string | null;
  readonly previous: readonly JobTicket[];
}
interface Active { readonly controller: AbortController; ticket: JobTicket | null; started: boolean }
function requireDevices(context: HostContext): NonNullable<HostContext['devices']> {
  if (!context.devices) throw new Error('当前宿主没有公开设备能力');
  return context.devices;
}
function errorLogId(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  for (const key of ['logId', 'lastKnownLogId', 'submitLogId']) {
    const value: unknown = Reflect.get(error, key);
    if (typeof value === 'string') return value;
  }
  return null;
}
/** 业务状态适配复用公开 Job 等待器，不另建执行器或自动重放设备写入。 */
export function createDeviceAction(context: HostContext, operations: OperationSource,
  options: JobOptions & { readonly timeoutMs?: number } = {}) {
  const devices = requireDevices(context);
  const timeout = options.timeoutMs ?? 30000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120000) throw new Error('等待期限须为1至120000毫秒');
  let state: DeviceActionState = Object.freeze({ phase: 'idle', pending: false, ticket: null,
    job: null, result: null, message: null, logId: null, previous: [] });
  let active: Active | null = null, closed = false;
  const lifetime = new AbortController(), listeners = new Set<() => void>();
  const currentOperations = () => {
    const snapshot = operations.snapshot();
    return snapshot.pending ? [] : snapshot.result?.data ?? [];
  };
  const publish = (change: Partial<DeviceActionState>) => {
    if (closed || context.signal.aborted) return;
    state = Object.freeze({ ...state, ...change });
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* 单个界面失败不影响任务状态或其他订阅。 */ }
    }
  };
  const admitted = (call: Active) => active === call && !closed && !context.signal.aborted;
  const begin = () => {
    if (closed || context.signal.aborted) throw new Error('设备动作所属界面已关闭');
    if (active) throw new Error('本次动作仍在等待，请先停止等待或查询结果');
    const call: Active = { controller: new AbortController(), ticket: null, started: false };
    active = call;
    const signal = AbortSignal.any([call.controller.signal, context.signal, lifetime.signal]);
    const timer = setTimeout(() => call.controller.abort(new Error('等待超时，结果尚未确认，请查询任务')), timeout);
    return { call, signal, finish: () => { clearTimeout(timer); if (active === call) active = null; } };
  };
  function gateway(call: Active, request?: DeviceActionRequest) {
    return createJobRunner({
      async submit(_operation, _input, signal) {
        if (!request) throw new Error('查询任务不得重新提交');
        signal.throwIfAborted(); call.started = true;
        try {
          const result = await abortable(devices.invoke(actionInput(request), signal), signal);
          if (admitted(call) && !signal.aborted) {
            const trusted = !!result.data.id && result.data.operation === request.capability.operation;
            call.ticket = trusted ? { id: result.data.id, operation: request.capability.operation, submitLogId: result.logId } : null;
            publish({ phase: 'waiting', ticket: call.ticket, job: trusted ? result.data : null, logId: result.logId });
          }
          return result;
        } catch (error) { throw apiError(error); }
      },
      getJob: async (id, signal) => {
        try { return await context.getJob(id, signal); } catch (error) { throw apiError(error); }
      },
      cancelJob: async () => { throw new Error('停止页面等待不调用服务器取消'); },
    }, options);
  }
  function failed(call: Active, error: unknown) {
    if (!admitted(call)) return;
    publish({ pending: false, phase: error instanceof JobFailure || !call.started ? 'failed' : 'unknown',
      job: error instanceof JobFailure ? error.job : state.job,
      message: error instanceof Error ? error.message : '调用结果尚未确认，请查询实际状态',
      logId: errorLogId(error) ?? state.logId });
  }
  async function run(request: DeviceActionRequest): Promise<DeviceActionState> {
    if (closed || context.signal.aborted) throw new Error('设备动作所属界面已关闭');
    if (active) throw new Error('本次动作仍在等待，请先停止等待或查询结果');
    const reason = deviceActionReason(devices.snapshot(), currentOperations(), request);
    if (reason) { publish({ phase: 'failed', pending: false, message: reason }); return state; }
    const activity = begin(), { call, signal } = activity;
    const previous = state.ticket ? [...state.previous, state.ticket].slice(-8) : state.previous;
    publish({ phase: 'submitting', pending: true, ticket: null, job: null, result: null, message: null, logId: null, previous });
    const schema = JSON.stringify(currentOperations().find((entry) => entry.id === request.capability.operation)?.input_schema);
    const validate = () => {
      const invalid = deviceActionReason(devices.snapshot(), currentOperations(), request);
      if (invalid || JSON.stringify(currentOperations().find((entry) => entry.id === request.capability.operation)?.input_schema) !== schema)
        call.controller.abort(new Error(invalid ?? '能力输入模式已变化，旧结果不再应用'));
    };
    const stopDevices = devices.subscribe(validate), stopOperations = operations.subscribe(validate);
    const runner = gateway(call, request);
    try {
      validate(); signal.throwIfAborted();
      const result = await runner.execute(request.capability.operation, request.input, signal, requireJson);
      validate(); signal.throwIfAborted();
      if (admitted(call)) publish({ phase: 'succeeded', pending: false, job: result.job,
        result: result.data, logId: result.logId, message: '任务已完成' });
    } catch (error) { failed(call, error); }
    finally { runner.dispose(); void stopDevices(); void stopOperations(); activity.finish(); }
    return state;
  }
  async function query(): Promise<DeviceActionState> {
    if (closed || context.signal.aborted) throw new Error('设备动作所属界面已关闭');
    const ticket = state.ticket;
    if (!ticket) { publish({ message: '尚未取得任务ID，请在任务记录中核对，勿直接重放写入' }); return state; }
    const activity = begin(), { call, signal } = activity;
    call.started = true; call.ticket = ticket;
    const runner = gateway(call);
    publish({ pending: true, message: '只查询已接纳任务，不重新提交设备动作' });
    try {
      const response = await runner.query(ticket, signal);
      signal.throwIfAborted();
      if (admitted(call)) {
        const job = response.data;
        publish({ pending: false, job, logId: response.logId,
          phase: job.status === 'succeeded' ? 'succeeded' : job.status === 'failed' || job.status === 'cancelled' ? 'failed' : 'unknown',
          result: job.status === 'succeeded' ? requireJson(job.result) : null,
          message: job.status === 'succeeded' ? '已查询到任务完成' : job.error ??
            (job.status === 'failed' ? '服务器已确认任务失败' : job.status === 'cancelled' ? '服务器已确认任务取消' : '后台仍未结束，可稍后再次查询') });
      }
    } catch (error) { failed(call, error); }
    finally { runner.dispose(); activity.finish(); }
    return state;
  }
  function cancel() {
    const call = active;
    if (!call) return;
    call.controller.abort(); active = null;
    publish({ pending: false, phase: call.started ? 'unknown' : 'idle',
      message: '仅停止页面等待，不代表后台任务取消；请查询实际结果' });
  }
  function dispose() {
    if (closed) return;
    closed = true; lifetime.abort(); active?.controller.abort(); active = null;
    context.signal.removeEventListener('abort', dispose); listeners.clear();
  }
  context.signal.addEventListener('abort', dispose, { once: true });
  return {
    snapshot: (): DeviceActionState => state,
    subscribe(listener: () => void): Dispose { listeners.add(listener); return () => { listeners.delete(listener); }; },
    run, query, cancel, dispose,
  };
}
export type DeviceActionModel = ReturnType<typeof createDeviceAction>;
