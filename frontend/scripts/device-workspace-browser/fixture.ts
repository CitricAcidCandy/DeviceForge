import { createProductFixture } from '../browser-product-fixture.ts';
import type { DeviceDirectoryDto, DeviceProviderDto } from '../../src/services/api/index.ts';
import type { FixtureRequest } from '../browser-product-fixture.ts';

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// 复用已有真实接口类型与业务夹具，仅扩展设备状态和发现响应。
export function createDeviceWorkspaceFixture() {
  const original = createProductFixture();
  const requests: FixtureRequest[] = [];
  const providers = original.providers;
  let failDiscovery = false;
  let missingOperations = false;
  let holdDiscovery = false;
  const pendingDiscovery = new Set<() => void>();
  const response = (data: unknown, status = 200) =>
    new Response(JSON.stringify({ log_id: 'device-workspace-fixture-log', data }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const directory = (provider: DeviceProviderDto): DeviceDirectoryDto => ({
    provider,
    observed_at: Date.now(),
    discovery_job_id: 'device-workspace-discovery',
    devices: [
      {
        reference: {
          provider_id: provider.id,
          generation: provider.generation,
          local_id: 'device-a',
        },
        model: provider.id === 'fixture.first' ? '设备甲 · 在线' : '设备乙 · 授权待确认',
        state: provider.id === 'fixture.first' ? 'online' : 'unauthorized',
        capabilities: provider.definition.capabilities
          .filter((capability) => capability.scope === 'device')
          .map((capability) => ({
            id: capability.id,
            version: capability.version,
            available: provider.id === 'fixture.first',
            reason: provider.id === 'fixture.first' ? null : '请在设备上允许调试授权',
          })),
      },
      ...(provider.id === 'fixture.first'
        ? [
            {
              reference: {
                provider_id: provider.id,
                generation: provider.generation,
                local_id: 'device-offline',
              },
              model: '设备丙 · 离线',
              state: 'offline',
              capabilities: [{ id: 'packages', version: 1, available: false, reason: '设备离线' }],
            } satisfies DeviceDirectoryDto['devices'][number],
          ]
        : []),
    ],
  });
  const transport: typeof fetch = async (resource, options) => {
    const url = resource instanceof Request ? new URL(resource.url) : new URL(String(resource));
    const method = options?.method ?? 'GET';
    const input: unknown = typeof options?.body === 'string' ? JSON.parse(options.body) : null;
    requests.push({ path: url.pathname + url.search, method, input });
    if (options?.signal?.aborted) throw new DOMException('设备页夹具请求已取消', 'AbortError');
    if (url.pathname === '/api/v2/device-providers') return response(providers);
    if (url.pathname === '/api/v2/devices') return response(providers.map(directory));
    if (url.pathname === '/api/v2/operations' && missingOperations) return response([]);
    if (url.pathname.startsWith('/api/v2/device-providers/') && url.pathname.endsWith('/refresh')) {
      // 受控响应可忽略取消而晚到，验收页面不得继续发布旧反馈。
      if (holdDiscovery) await new Promise<void>((done) => pendingDiscovery.add(done));
      if (failDiscovery)
        return new Response(
          JSON.stringify({
            log_id: 'device-workspace-fixture-log',
            error: { code: 'provider_unavailable', message: '受控提供者发现失败' },
          }),
          { status: 503, headers: { 'content-type': 'application/json' } },
        );
      const id = decodeURIComponent(url.pathname.split('/')[4] ?? '');
      const provider = providers.find((item) => item.id === id);
      if (provider && object(input) && input['generation'] === provider.generation)
        return response(directory(provider));
      return response(null, 404);
    }
    return original.transport(resource, options);
  };
  return {
    transport,
    requests,
    providers,
    setDiscoveryFailure(value: boolean) {
      failDiscovery = value;
    },
    setMissingOperations(value: boolean) {
      missingOperations = value;
    },
    holdDiscovery(value: boolean) {
      holdDiscovery = value;
    },
    releaseDiscovery() {
      holdDiscovery = false;
      for (const done of pendingDiscovery) done();
      pendingDiscovery.clear();
    },
    pendingDiscovery: () => pendingDiscovery.size,
  };
}
