import type { createPluginManager } from '../plugins/index.ts';
import type { ExtensionRegistry } from '../plugins/extensions/registry.ts';

// 工具贡献独立于业务路由，目录锁内只安排工作，不等待插件挂载回调。
export function createDeveloperToolsHost(registry: ExtensionRegistry, manager: ReturnType<typeof createPluginManager>) {
  const entries = new Map<string, { generation: number; state: 'mounting' | 'mounted' | 'failed' }>();
  let closed = false, scheduled = false;
  function sync() {
    if (closed || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (closed) return;
      const loaded = manager.snapshot().filter((plugin) => plugin.state === 'loaded');
      const contributions = registry.catalog().components.filter((entry) => entry.slot === 'developer.tools' &&
        loaded.some((plugin) => plugin.id === entry.pluginId && plugin.generation === entry.generation));
      for (const [id, entry] of entries) {
        if (contributions.some((current) => current.id === id && current.generation === entry.generation)) continue;
        entries.delete(id);
        // 排队卸载在下一代挂载前入队；旧完成结果不能更改新条目。
        void manager.unmountExtension(id).catch(() => undefined);
      }
      for (const contribution of contributions) {
        if (entries.has(contribution.id)) continue;
        const entry: { generation: number; state: 'mounting' | 'mounted' | 'failed' } =
          { generation: contribution.generation, state: 'mounting' };
        entries.set(contribution.id, entry);
        void manager.mountComponent(contribution.id).then(() => {
          if (!closed && entries.get(contribution.id) === entry) entry.state = 'mounted';
        }, () => {
          if (!closed && entries.get(contribution.id) === entry) entry.state = 'failed';
        });
      }
    });
  }
  const unsubscribe = registry.subscribe(sync);
  sync();
  return { sync, snapshot: () => [...entries].map(([id, entry]) => ({ id, ...entry })),
    async dispose() {
      if (closed) return;
      closed = true; unsubscribe();
      const ids = [...entries.keys()]; entries.clear();
      await Promise.allSettled(ids.map((id) => manager.unmountExtension(id)));
    },
  };
}
