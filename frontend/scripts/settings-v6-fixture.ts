import { createProductServices } from '../src/app/product/services.ts';
import type { ProductServices } from '../src/app/product/services.ts';
import type { SettingsResult } from '../src/features/settings/index.ts';
import type { JobOutcome } from '../src/shared/jobs/index.ts';
import { createNamedSlotAdapter } from '../src/plugins/index.ts';
import { ApiError } from '../src/services/api/index.ts';

type ConnectionMode = 'success' | 'network' | 'logged' | 'waiting';
export async function createSettingsV6Fixture(target: HTMLElement) {
  let mode: ConnectionMode = 'success';
  let release: (() => void) | null = null;
  let revision = 1;
  let value: SettingsResult['value'] = { name: '初始配置' };
  const reconnects: { url: string; signal: AbortSignal }[] = [];
  const writes: string[] = [];
  const mounted = { count: 0, released: 0 };
  const slots = await createNamedSlotAdapter([]);
  const operations = ['list', 'get', 'set', 'delete', 'import', 'remote.load', 'remote.save'].map((entry) => ({
    id: `plugin.settings.${entry}`, title: entry, input_schema: { type: 'object' },
  }));
  const original = createProductServices({
    baseUrl: 'http://127.0.0.1:7031',
    panelTarget: () => target,
    slotAdapter: slots,
    themeTarget: target,
    transport: async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const data: unknown = url.pathname.endsWith('/operations') ? operations : [];
      return Response.json({ log_id: 'settings-v6-api', data });
    },
    connection: {
      baseUrl: 'http://127.0.0.1:7031',
      async reconnect(url, _token, signal) {
        reconnects.push({ url, signal });
        if (mode === 'network') throw new ApiError('network', 'unreachable', '无法连接服务，请检查地址或确认服务已启动。');
        if (mode === 'logged') throw new ApiError('http', 'unavailable', '服务暂时不可用', 503, 'settings-v6-real-response-log');
        if (mode === 'waiting') await new Promise<void>((resolve) => { release = resolve; });
        if (signal.aborted) throw new DOMException('连接已取消', 'AbortError');
      },
    },
  });
  function result(operation: string, data: SettingsResult): JobOutcome<SettingsResult> {
    return {
      data, logId: 'settings-v6-config-log', submitLogId: 'settings-v6-submit-log',
      job: { id: 'settings-v6-config-job', operation, status: 'succeeded', result: null, error: null },
    };
  }
  const services: ProductServices = {
    ...original,
    settings: {
      ...original.settings,
      async list(_input, signal) {
        signal.throwIfAborted();
        return result('plugin.settings.list', { format_version: 1, revision: String(revision), sections: { general: value ?? null } });
      },
      async get(input, signal) {
        signal.throwIfAborted();
        return result('plugin.settings.get', { format_version: 1, revision: String(revision), section: input.section, value: value ?? null });
      },
      async set(input, signal) {
        signal.throwIfAborted();
        if (input.expected_revision !== String(revision)) throw new Error('配置修订冲突，请重查后修改');
        writes.push(input.section);
        value = input.value;
        revision++;
        return result('plugin.settings.set', { format_version: 1, revision: String(revision), section: input.section, value });
      },
    },
  };
  services.runtime.webPlugins.register({
    id: 'settings-v6-demo', trusted: true,
    plugin: {
      id: 'settings-v6-demo', version: '1.0.0', apiVersion: 2, panels: [],
      contributions: {
        components: [{
          id: 'settings-v6-demo.preferences', title: '示例插件设置', slot: 'settings.plugin.section', mode: 'append',
          async mount(root) {
            mounted.count++;
            const field = root.ownerDocument.createElement('input');
            field.setAttribute('aria-label', '插件草稿');
            field.className = 'h-9 w-full max-w-96 rounded-[5px] border border-input bg-background px-3 text-sm';
            root.append(field);
            return () => { mounted.released++; field.remove(); };
          },
        }],
      },
    },
  });
  return {
    services, reconnects, writes, mounted,
    mode(value: ConnectionMode) { mode = value; },
    complete() { release?.(); release = null; },
    async loadPlugin() { await services.runtime.webPlugins.load('settings-v6-demo'); },
    async unloadPlugin() { await services.runtime.webPlugins.unload('settings-v6-demo'); },
    async dispose() { release?.(); await services.dispose(); await slots.dispose(); },
  };
}

export type SettingsV6Fixture = Awaited<ReturnType<typeof createSettingsV6Fixture>>;
