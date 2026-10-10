import { ApiError, operationsEndpoint } from '../../shared/api/index.ts';
import type { ApiClient } from '../../shared/api/index.ts';
import { abortable } from '../../shared/api/abort.ts';
import { createOperationState } from './state.ts';

export function createOperations(client: ApiClient) {
  const state = createOperationState();
  const lifetime = new AbortController();
  let observation = new AbortController();
  async function list(signal: AbortSignal) {
    const admitted = observation;
    const current = AbortSignal.any([signal, admitted.signal, lifetime.signal]);
    if (current.aborted) throw new ApiError('cancelled', 'cancelled', '操作目录请求等待已取消');
    const result = await abortable(client.call(operationsEndpoint, undefined, current), current);
    if (current.aborted || admitted !== observation) throw new ApiError('cancelled', 'stale_result', '旧操作列表响应已撤销');
    return result;
  }
  return {
    list,
    refresh: (signal: AbortSignal) => state.refresh(list, signal),
    snapshot: state.snapshot,
    subscribe: state.subscribe,
    invalidate() {
      if (lifetime.signal.aborted) throw new ApiError('cancelled', 'cancelled', '操作目录已关闭，请求等待已取消');
      observation.abort(); observation = new AbortController(); state.invalidate();
    },
    dispose() { state.dispose(); lifetime.abort(); observation.abort(); },
  };
}
export type Operations = ReturnType<typeof createOperations>;
