/**
 * 槽位标识的归一化只此一份：宿主装配槽位、路由解析、插件模块派生页面槽位都要用同一条规矩，
 * 否则插件写 `My Page` 与宿主算出的 `my-page` 对不上，表现就是「挂载成功但看不见」。
 * 这份代码放在 SDK 里，是因为 `plugins/**` 不能 import `app/**`，但可以 import SDK。
 */
const slotKeyPattern = /^[a-z][a-z0-9._-]{0,63}$/;
const pluginIdPattern = /^[a-z][a-z0-9._-]{0,99}$/;

export function slotKey(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+/, '');
  return slotKeyPattern.test(normalized) ? normalized : `page-${normalized}`.slice(0, 64);
}

/** 合法插件 ID 是身份，不按页面片段的 64 字符规则截断；兼容旧的展示名输入。 */
export function pluginSlotKey(pluginId: string): string {
  return pluginIdPattern.test(pluginId) ? pluginId : slotKey(pluginId);
}

/** 插件模块派生的页面槽位：`page.<pluginId>.<page>`。 */
export function pageSlotId(pluginId: string, page: string): string {
  return `page.${pluginSlotKey(pluginId)}.${slotKey(page)}`;
}
