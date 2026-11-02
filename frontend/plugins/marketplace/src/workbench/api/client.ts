import { ApiError } from '@deviceforge/plugin-sdk';
import type { HostContext, PluginJsonRequest } from '@deviceforge/plugin-sdk';
import { abortable, isJsonData } from '@deviceforge/business-kit';
import type { ApiClient, Endpoint } from './types.ts';

/** 只适配既有公开通信；地址、凭据、发布修订和日志仍由宿主管理。 */
export function createMarketplaceApi(context: HostContext): ApiClient {
  return {
    async call<I, O>(endpoint: Endpoint<I, O>, input: I, caller: AbortSignal) {
      const signal = AbortSignal.any([caller, context.signal]);
      signal.throwIfAborted();
      const transport = context.transport;
      if (!transport) throw new ApiError('protocol', 'marketplace_transport_unavailable', '宿主未提供公开管理通信');
      const spec = endpoint.request(input);
      const request: PluginJsonRequest = {
        path: spec.path, method: spec.method,
        ...(spec.headers === undefined ? {} : { headers: spec.headers }),
        ...(spec.contentType === undefined ? {} : { contentType: spec.contentType }),
        ...(spec.body instanceof Blob || spec.body instanceof ArrayBuffer ? { content: spec.body } : {}),
      };
      let body: unknown;
      if (typeof spec.body === 'string') {
        body = JSON.parse(spec.body);
        if (!isJsonData(body)) throw new ApiError('protocol', 'invalid_marketplace_management_input', '管理请求必须是有限 JSON');
      }
      const result = await abortable(transport.request(
        isJsonData(body) ? { ...request, body } : request, signal,
      ), signal);
      signal.throwIfAborted();
      if (!endpoint.decode(result.data))
        throw new ApiError('protocol', 'invalid_marketplace_management_result', '管理接口返回格式不兼容', null, result.logId);
      return { data: result.data, logId: result.logId };
    },
    async downloadArtifact(id, signal) {
      if (!context.artifacts) throw new ApiError('protocol', 'marketplace_artifacts_unavailable', '宿主未提供产物读取');
      const current = AbortSignal.any([signal, context.signal]);
      current.throwIfAborted();
      return abortable(context.artifacts.download(id, current), current);
    },
  };
}
