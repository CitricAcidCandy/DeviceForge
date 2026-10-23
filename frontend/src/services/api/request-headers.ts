import type { ApiClient, Endpoint, RequestSpec } from './types.ts';
import { ApiError } from './errors.ts';
import { abortable } from './abort.ts';

export interface PluginReleaseReference {
  readonly id: string;
  readonly revision: string;
}

export function withRequestHeaders(
  client: ApiClient,
  resolve: (request: RequestSpec, signal: AbortSignal) =>
    Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>,
): ApiClient {
  return {
    async call<I, O>(endpoint: Endpoint<I, O>, input: I, signal: AbortSignal) {
      if (signal.aborted) throw new ApiError('cancelled', 'cancelled', '请求等待已取消');
      const request = endpoint.request(input);
      const headers = await abortable(Promise.resolve(resolve(request, signal)), signal);
      if (signal.aborted) throw new ApiError('cancelled', 'cancelled', '请求等待已取消');
      return client.call({
        request: () => ({ ...request, headers: { ...request.headers, ...headers } }),
        decode: endpoint.decode,
      }, input, signal);
    },
    downloadArtifact: client.downloadArtifact,
  };
}

export function pluginReleaseHeaders(reference: PluginReleaseReference): Readonly<Record<string, string>> {
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(reference.id) || !/^[a-f0-9]{64}$/.test(reference.revision))
    throw new Error('插件发布身份或修订无效');
  return { 'x-deviceforge-plugin-release': JSON.stringify({ id: reference.id, revision: reference.revision }) };
}

export function withPluginRelease(client: ApiClient, reference: PluginReleaseReference): ApiClient {
  // 在构建组件上下文时固定修订，后续目录变化不能替旧代码冒领新修订。
  const headers = pluginReleaseHeaders(reference);
  return withRequestHeaders(client, () => headers);
}
