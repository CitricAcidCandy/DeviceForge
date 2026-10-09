import type { WebPlugin } from '../plugin-sdk/index.ts';

export function validateContributions(plugins: readonly WebPlugin[]): void {
  const ids = new Set<string>();
  const panels = new Set<string>();
  for (const plugin of plugins) {
    if (plugin.apiVersion !== 1 || !/^[a-z][a-z0-9._-]{0,99}$/.test(plugin.id) || !plugin.version) {
      throw new Error('插件标识、版本或协议无效');
    }
    if (ids.has(plugin.id)) throw new Error(`插件重复：${plugin.id}`);
    ids.add(plugin.id);
    for (const panel of plugin.panels) {
      if (!panel.id.startsWith(`${plugin.id}.`) || panels.has(panel.id) || !panel.title.trim()) {
        throw new Error(`面板贡献无效或重复：${panel.id}`);
      }
      panels.add(panel.id);
    }
  }
}
