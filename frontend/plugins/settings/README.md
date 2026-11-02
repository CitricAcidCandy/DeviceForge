# 官方设置插件

## 当前范围

身份和版本由唯一的 `manifest.json` 注入。生产源码只引用公开 SDK、React、Radix 与图标包，不导入宿主的页面、功能工厂或集中服务。

已迁入修订配置读写、删除确认、整批导入、旧备份转换、远端配置与本地备份、主题选择，以及设置工作区和开放设置扩展点。构造和插件激活不发业务请求。隐藏分类保留草稿，写入冲突不重试；已接受任务的等待取消保留回执，并可查询原任务。

## 集成前置与未完成项

以下是设置插件需要的平台能力契约。**连接与 MCP 目录服务已接入实际 runtime**，只复用原能力，不另建连接器；市场地址服务随独立市场能力插件登记。设置已进入清单发现的默认装配，原市场页面仍未迁移。能力缺失时仅对应功能不可用，设置插件本身、工具配置和其他独立功能继续运行。源码接线不表示真实连接、MCP 或整个设置体验已验收。

| 服务引用 | 输入 | 输出 |
| --- | --- | --- |
| `host.connection@1` | `{ action: "status" }` | `{ baseUrl: string, canReconnect: boolean }` |
| `host.connection@1` | `{ action: "reconnect", baseUrl: string, token: string }` | 成功后的同一连接状态；令牌不返回、不持久化 |
| `host.mcp@1` | `{ action: "listTools" }` | `{ tools: [{ name, title?, description?, inputSchema }] }` |
| `deviceforge_marketplace.preferences@1` | `{ action: "get" }` | `{ url: string }` |
| `deviceforge_marketplace.preferences@1` | `{ action: "set", url: string }` 或 `{ action: "reset" }` | `{ url: string }` |

服务调用只承载有限请求，不把返回后的服务调用信号用于长期 MCP 订阅。MCP 持续连接状态、通知与真实连接订阅仍需公开长期资源契约；当前仅支持真实工具目录读取，不能以此代替旧页面的全部 MCP 体验。

新的 `<插件身份>.sections@1` 设置扩展点消费 `{ title, view: { pluginId, viewId } }`，完整视图经公开 `ui.mount` 挂载。原 `settings.plugin.section` 已由宿主兼容层投影为该公开视图贡献，仍位于“插件扩展”分类、只追加；本插件不通过私有管理器读取旧组件。目录和撤销已定向单元验证，实际浏览器渲染仍未验收。

默认清单接线已由主代理完成；全局旧装配全部退役、市场页面迁移、浏览器或运行视觉验收仍未完成，不以服务存在代替完整迁移。

## 定向验证

宿主工程验证使用本目录 `tests/public-imports.ts` 仅解析公开 SDK，并为 Node 单元转译 TSX。生产插件不使用测试别名。独立发行开发仍安装实际提供的 SDK 开发包。

已执行：模型 6 项、登记及公开响应 5 项、取消等待交互 1 项单元通过；本插件严格类型检查通过。没有执行完整构建、浏览器、真实服务器或 MCP 连接验收。
