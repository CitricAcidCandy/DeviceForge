import type { WorkspacePageInfo, WebPluginRuntimeInfo } from '../../plugin-sdk/index.ts';

export interface PageAdoptionOptions {
  readonly key: string;
  readonly persistence?: Pick<Storage, 'getItem' | 'setItem'>;
}

/** 迁移归属来自实际成功登记的页面，不根据插件名字猜测它是否替代旧页面。 */
export function createPageAdoption(options: PageAdoptionOptions) {
  const adopted = new Set<string>();
  let writable = true;
  let error: string | null = null;
  try {
    const raw = options.persistence?.getItem(options.key);
    if (raw) {
      if (raw.length > 8192) throw new Error('页面迁移记录超过容量');
      const saved: unknown = JSON.parse(raw);
      if (!Array.isArray(saved) || saved.some((path) => typeof path !== 'string' || !/^\/[a-z][a-z0-9._-]*$/.test(path)))
        throw new Error('页面迁移记录无效，保留原内容');
      for (const path of saved) if (typeof path === 'string') adopted.add(path);
    }
  } catch (failure) {
    writable = false;
    error = failure instanceof Error ? failure.message : '页面迁移记录读取未确认';
  }
  return {
    has: (route: string) => adopted.has(route),
    error: () => error,
    observe(pages: readonly WorkspacePageInfo[], loaded: readonly WebPluginRuntimeInfo[], ownerId: string) {
      let changed = false;
      for (const page of pages) {
        if (page.pluginId === ownerId || !/^\/[a-z][a-z0-9._-]*$/.test(page.route) ||
            !loaded.some((entry) => entry.id === page.pluginId && entry.generation === page.generation && entry.state === 'loaded') ||
            adopted.has(page.route)) continue;
        adopted.add(page.route); changed = true;
      }
      if (changed && writable) {
        try { options.persistence?.setItem(options.key, JSON.stringify([...adopted].sort())); }
        catch (failure) {
          writable = false;
          error = failure instanceof Error ? failure.message : '页面迁移记录保存未确认';
        }
      }
      return changed;
    },
  };
}
