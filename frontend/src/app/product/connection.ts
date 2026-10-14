import { createApiClient, operationsEndpoint } from '../../shared/api/index.ts';

export function productServiceOrigin(value: string): string {
  const parsed = new URL(value.trim());
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw new Error('请填写不带路径、凭证或查询参数的 HTTP 服务地址');
  return parsed.origin;
}
// 先核对新连接，再释放当前运行实例；失败时保留原会话和草稿。
export async function probeProductConnection(baseUrl: string, token: string, transport: typeof fetch, signal: AbortSignal) {
  const client = createApiClient({baseUrl: productServiceOrigin(baseUrl), transport, tokenProvider: () => token || null});
  return client.call(operationsEndpoint, undefined, AbortSignal.any([signal, AbortSignal.timeout(15000)]));
}
