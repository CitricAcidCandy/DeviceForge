# 浏览器插件公开契约

作用：SDK v2 独立版本化宿主上下文、生命周期与开放贡献契约，不导入任何宿主模块、生成 DTO 或令牌。

定义满足 WebPlugin 的对象，所有贡献 ID 使用 `<插件ID>.<贡献名>`。面板与组件/模块 mount 接受专属 HTMLElement 和 HostContext，返回 Dispose；异步资源必须处理 context.signal，并用 onDispose 登记事件/定时器等释放逻辑。

v1 升级：apiVersion 改为 2；所有请求显式传信号，成功从 HostResult.data 读取模型，并保留 logId。HostError 包含错误分类、代码、状态、日志 ID 与限流等待值。Operation.input_schema 可为任意 JSON 模式；任务无结果/无错误映射为 null。

WebPlugin.contributions 为兼容的可选字段，包括具名 components、路由 modules、commands、显式版本 services 及 beforeTaskSubmit。extensions 提供公开目录、命令/服务调用、事件、状态；插件专属上下文允许动态 register。状态/发射事件必须使用自身命名空间；host.* 由宿主发布。手动撤销与卸载均收敛贡献。

components.mode 缺省为 append；replace 通过公开 SlotAdapter 获取宿主受控租约。宿主可注入 createNamedSlotAdapter 的具名默认 renderer，替换时释放默认渲染，卸载恢复。没有直接修改宿主私有 DOM；具体 UI 框架由插件自带。json.ts 校验公开扩展输入/输出，拒绝循环引用、类实例和非有限数字。

InstalledWebPackage 为浏览器 SDK 安装目录映射，不是后端 DTO；entryPath 经宿主 PackageEntryResolver 映射至本代 UUID 资源前缀，EsmImporter 注入实际 ESM 导入。

models.ts 定义共有 JSON、HostResult/HostError、Operation 与 Job，index.ts 保持公开重导出；devices.ts 定义独立设备模型和 DeviceAccess。HostContext.devices 是 apiVersion 2 可选加法字段，旧宿主可省略。refreshProviders/refreshDirectories/refreshProvider/invoke 返回 HostResult；select/snapshot/subscribe 提供选择与观测，subscribe 返回 Dispose。DeviceRef 使用 providerId/generation/localId，DeviceAction 使用 providerId/generation/deviceId/capability/version/input；HTTP 字段只由宿主显式映射。

刷新开始清旧观测，提供者消失/代变与切换设备拒绝旧结果；实例和面板/组件/模块作用域合并设备请求取消并释放订阅。关闭后所有设备入口拒绝使用。本地准入错误不生成 logId，HTTP 错误保留服务日志关联。当前 SDK 不提供服务器管理、包管理或产物适配，设备页面与常驻会话仍不属于此契约交付。
