export declare function slotKey(value: string): string;
/** 合法插件 ID 是身份，不按页面片段的 64 字符规则截断；兼容旧的展示名输入。 */
export declare function pluginSlotKey(pluginId: string): string;
/** 插件模块派生的页面槽位：`page.<pluginId>.<page>`。 */
export declare function pageSlotId(pluginId: string, page: string): string;
