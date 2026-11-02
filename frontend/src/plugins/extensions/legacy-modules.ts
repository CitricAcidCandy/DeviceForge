import { pluginSlotKey, slotKey } from '../../plugin-sdk/slots.ts';
import type { Dispose, ModuleContribution, UiAccess } from '../../plugin-sdk/index.ts';

/** 旧模块复用原归属、代次和挂载回调，进入新页面目录而不创建第二份执行器。 */
export function registerLegacyModulePages(ui: UiAccess, pluginId: string, modules: readonly ModuleContribution[]): Dispose {
  return ui.register({ pages: modules.map((entry) => ({
    id: entry.id, title: entry.title,
    route: `/plugin/${pluginSlotKey(pluginId)}/${slotKey(entry.route)}`,
    navigation: { group: '插件', order: 1000 },
    mount: entry.mount,
  })) });
}
