import { HostError } from '../../plugin-sdk/index.ts';
import type { Dispose, HostContext, JsonValue } from '../../plugin-sdk/index.ts';
import type { ExtensionRegistry } from '../../plugins/extensions/registry.ts';
import type { SlotDirectory } from '../../plugins/index.ts';
import { isJsonData } from '../../shared/jobs/values.ts';

export interface UiDirectoryOptions {
  readonly host: HostContext;
  readonly extensions: Pick<ExtensionRegistry, 'register'>;
  readonly slots?: SlotDirectory;
}

/** 只读公开元数据；不返回 DOM、挂载函数、业务目标、布局数据或本地贡献载荷。 */
export function registerUiDirectory(options: UiDirectoryOptions): Dispose {
  const { host } = options;
  host.signal.throwIfAborted();
  const releases: Dispose[] = [];
  let closed = false, revision = 0;
  const notify = () => {
    if (!closed && !host.signal.aborted)
      host.extensions?.emitEvent('host.ui-directory.changed', { revision: ++revision });
  };
  function snapshot(): JsonValue {
    const ui = host.ui, points = host.extensions?.points;
    const pointCatalog = points?.catalog();
    const value: unknown = {
      snapshotVersion: 1, revision,
      slots: { known: options.slots !== undefined, entries: options.slots?.catalog() ?? [] },
      points: { known: points !== undefined, definitions: pointCatalog?.definitions ?? [],
        contributions: pointCatalog?.contributions.map(({ data: _data, ...entry }) => entry) ?? [] },
      ui: { known: ui !== undefined, catalog: ui?.catalog() ?? { pages: [], workspaces: [], views: [] },
        instances: ui?.snapshot().instances.map(({ target: _target, ...entry }) => entry) ?? [] },
    };
    if (!isJsonData(value)) throw new HostError('protocol', 'invalid_ui_directory', '界面目录不是有限 JSON 数据');
    if (new TextEncoder().encode(JSON.stringify(value)).length > 8 * 1024 * 1024)
      throw new HostError('protocol', 'ui_directory_limit', '界面目录超过读取限额，请缩小已登记内容');
    return structuredClone(value);
  }
  let disposal: Promise<void> | null = null;
  const dispose = () => {
    if (disposal) return disposal;
    closed = true;
    const tasks = releases.splice(0).reverse().map((release) => Promise.resolve().then(release));
    disposal = Promise.allSettled(tasks).then((results) => {
      const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, '界面目录订阅未完全释放');
    });
    return disposal;
  };
  try {
    releases.push(options.extensions.register({ pluginId: 'host', generation: 0, context: host }, { services: [{
      id: 'host.ui-directory', version: '1',
      inputSchema: { type: 'object', required: ['action'], additionalProperties: false, properties: { action: { const: 'snapshot' } } },
      async invoke(input, _context, signal) {
        signal.throwIfAborted();
        if (closed || host.signal.aborted) throw new HostError('cancelled', 'ui_directory_revoked', '界面目录已撤销');
        if (input === null || typeof input !== 'object' || Array.isArray(input) || input.action !== 'snapshot' || Object.keys(input).length !== 1)
          throw new HostError('protocol', 'invalid_ui_directory_request', '界面目录仅支持只读快照');
        return { data: snapshot(), logId: null };
      },
    }] }));
    if (host.ui) releases.push(host.ui.subscribe(notify));
    if (host.extensions?.points) releases.push(host.extensions.points.subscribe(notify));
    if (options.slots) releases.push(options.slots.subscribe(notify));
  } catch (error) {
    void dispose().catch(() => undefined);
    throw error;
  }
  return host.onDispose(dispose);
}
