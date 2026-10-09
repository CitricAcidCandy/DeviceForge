import { operationsEndpoint } from '../../shared/api/index.ts';
import type { ApiClient, OperationDto } from '../../shared/api/index.ts';
import { createLatestResource } from '../../shared/lifecycle/latest.ts';

export function createOperations(client: ApiClient) {
  const resource = createLatestResource<OperationDto[]>();
  const lifetime = new AbortController();
  const list = (signal: AbortSignal) => client.call(operationsEndpoint, undefined, AbortSignal.any([signal, lifetime.signal]));
  return {
    list,
    refresh: (signal: AbortSignal) => resource.run(list, signal),
    snapshot: resource.snapshot,
    subscribe: resource.subscribe,
    dispose() { lifetime.abort(); resource.dispose(); },
  };
}
export type Operations = ReturnType<typeof createOperations>;
