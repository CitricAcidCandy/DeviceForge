import type { PackageInfo, PluginInfo } from '../../src/services/api/index.ts';

export const pluginIds = {
  running: 'defaults.server-running',
  idle: 'defaults.server-idle',
  failure: 'defaults.browser-failure',
  success: 'defaults.browser-success',
} as const;

// 使用生成 HTTP 类型构造安装及运行目录；不连接正式 Rust 服务。
export function createDefaultsFixture() {
  const requests: { path: string; method: string; at: string }[] = [];
  const assets: { id: string; run: string; path: string }[] = [];
  const server = new Map<string, PluginInfo>([
    [pluginIds.running, {
      id: pluginIds.running, version: '1.0.0', state: 'loaded',
      generation: 'already-running-generation', operations: [], protected: false,
      cleanup_failed: false,
    }],
  ]);
  const packageInfo = (id: string, kind: 'server' | 'browser'): PackageInfo => ({
    id, kind, version: '1.0.0', runtime: kind === 'browser' ? 'browser' : 'process',
    entry_path: 'dist/index.js', api_version: kind === 'browser' ? 2 : 1,
    installed_at: 1,
  });
  const packages = {
    server: [packageInfo(pluginIds.running, 'server'), packageInfo(pluginIds.idle, 'server')],
    browser: [packageInfo(pluginIds.failure, 'browser'), packageInfo(pluginIds.success, 'browser')],
  };
  return {
    requests, assets,
    snapshot: () => ({ requests, assets, server: [...server.values()] }),
    handle(path: string, method: string): { status: number; data: unknown } {
      requests.push({ path, method, at: new Date().toISOString() });
      const url = new URL(path, 'http://127.0.0.1');
      if (url.pathname === '/api/v2/plugins') return { status: 200, data: [...server.values()] };
      if (url.pathname === '/api/v2/plugin-packages/server') return { status: 200, data: packages.server };
      if (url.pathname === '/api/v2/plugin-packages/browser') return { status: 200, data: packages.browser };
      const action = url.pathname.match(/^\/api\/v2\/plugins\/([^/]+)\/(load|unload)$/);
      if (action && method === 'POST') {
        const id = action[1];
        if (!id || !packages.server.some((entry) => entry.id === id)) return { status: 404, data: null };
        const old = server.get(id);
        const next: PluginInfo = {
          id, version: '1.0.0', state: action[2] === 'load' ? 'loaded' : 'unloaded',
          generation: old?.generation ?? 'new-default-generation', operations: [],
          protected: false, cleanup_failed: false,
        };
        server.set(id, next);
        return { status: 200, data: next };
      }
      if (['/api/v2/operations', '/api/v2/devices', '/api/v2/device-providers', '/api/v2/jobs'].includes(url.pathname))
        return { status: 200, data: [] };
      return { status: 404, data: null };
    },
  };
}
