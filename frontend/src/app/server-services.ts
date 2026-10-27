import { callServerServiceEndpoint, serverServicesEndpoint } from '../services/api/server-services.ts';
import type { ApiClient } from '../services/api/index.ts';
import type { ServiceDirectoryEntry, ServerServiceAccess, HostResult } from '../plugin-sdk/index.ts';
import { HostError } from '../plugin-sdk/index.ts';
import { isJsonValue } from '../plugin-sdk/json.ts';
import { publicCall, publicJob } from './public-api.ts';

export function createServerServiceAccess(client: ApiClient, lifetime: AbortSignal): ServerServiceAccess {
  const combined = (signal: AbortSignal) => {
    if (lifetime.aborted) throw new HostError('cancelled', 'services_revoked', '服务器服务入口已撤销');
    return AbortSignal.any([signal, lifetime]);
  };
  async function deliver<T, U>(signal: AbortSignal, request: (signal: AbortSignal) => Promise<HostResult<T>>, map: (value: T) => U) {
    const current = combined(signal);
    return publicCall(request(current), (value) => {
      if (current.aborted) throw new HostError('cancelled', 'service_result_revoked', '服务响应已撤销；已提交的服务器任务不会因此回滚');
      return map(value);
    });
  }
  return {
    list: (signal) => deliver(signal, (current) => client.call(serverServicesEndpoint, undefined, current), (items) => items.map((entry): ServiceDirectoryEntry => {
      if (!isJsonValue(entry.contract.input_schema) || !isJsonValue(entry.contract.output_schema))
        throw new HostError('protocol', 'service_schema_invalid', '服务契约不是 JSON 值');
      return { service: { ...entry.service }, contract: { inputSchema: entry.contract.input_schema, outputSchema: entry.contract.output_schema },
        operation: entry.operation, provider: { ...entry.provider }, available: entry.available, reason: entry.unavailable_reason ?? null };
    })),
    submit: (ref, input, signal, generation) => deliver(signal, (current) => client.call(callServerServiceEndpoint, {
      id: ref.id, body: { version: ref.version, input, generation: generation ?? null },
    }, current), publicJob),
  };
}
