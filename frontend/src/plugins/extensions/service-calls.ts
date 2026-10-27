import { HostError } from '../../plugin-sdk/models.ts';
import type { HostContext, HostResult, JsonValue, ServiceAccess, ServiceRef } from '../../plugin-sdk/index.ts';
import { awaitLifecycle } from '../lifecycle.ts';

export interface ServiceCallFrame {
  readonly path: readonly string[];
  readonly deadline: number;
  readonly root: { active: number };
  readonly signal: AbortSignal;
}
type Caller = (ref: ServiceRef, input: JsonValue, signal: AbortSignal, frame: ServiceCallFrame) => Promise<HostResult<JsonValue>>;
type Commander = (id: string, input: JsonValue, signal: AbortSignal, frame: ServiceCallFrame) => Promise<HostResult<JsonValue>>;

export async function withinServiceCall<T>(
  id: string, signal: AbortSignal, parent: ServiceCallFrame | undefined,
  run: (frame: ServiceCallFrame) => Promise<T>,
): Promise<T> {
  if (signal.aborted || parent?.signal.aborted)
    throw new HostError('cancelled', 'service_call_revoked', '服务调用作用域已撤销');
  const path = parent?.path ?? [];
  const root = parent?.root ?? { active: 0 };
  if (path.includes(id)) throw new HostError('protocol', 'service_recursive_call', '服务调用链不允许递归');
  if (path.length >= 8) throw new HostError('protocol', 'service_depth_exceeded', '服务调用深度超过 8 层');
  if (root.active >= 4) throw new HostError('protocol', 'service_concurrency_exceeded', '本次服务调用链已达 4 个并发上限');
  const controller = new AbortController();
  const frame: ServiceCallFrame = { path: [...path, id], root,
    deadline: Math.min(parent?.deadline ?? Infinity, Date.now() + 30_000),
    signal: AbortSignal.any([signal, controller.signal, ...(parent ? [parent.signal] : [])]) };
  root.active++;
  try { return await awaitLifecycle(() => run(frame), frame.signal, frame.deadline, '服务调用'); }
  finally { controller.abort(); root.active--; }
}

// 调用上下文显式携带父期限和取消，不能从根上下文重新起一条无归属调用链。
export function serviceInvocationContext(context: HostContext, frame: ServiceCallFrame, call: Caller, execute: Commander): HostContext {
  const invoke = (ref: ServiceRef, input: JsonValue, signal: AbortSignal) => call(ref, input, signal, frame);
  const upstream = context.services;
  const services: ServiceAccess | undefined = upstream ? {
    ...upstream,
    call: invoke,
    async callTyped(ref, input, signal) {
      if (!ref.accepts(input)) throw new HostError('protocol', 'service_input_invalid', '服务输入不符合类型契约');
      const result = await invoke(ref, input, signal);
      if (!ref.returns(result.data)) throw new HostError('protocol', 'service_output_invalid', '服务输出不符合类型契约', result.logId);
      return { data: result.data, logId: result.logId };
    },
  } : undefined;
  return { ...context, signal: frame.signal,
    ...(services ? { services } : {}),
    ...(context.extensions ? { extensions: { ...context.extensions,
      executeCommand: (id, input, signal) => execute(id, input, signal, frame),
      callService: (id, version, input, signal) => invoke({ id, version }, input, signal) } } : {}) };
}
