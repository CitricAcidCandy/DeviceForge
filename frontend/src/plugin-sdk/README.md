# 浏览器插件公开契约

作用：SDK v2 独立版本化宿主上下文、生命周期与开放贡献契约，不导入任何宿主模块、生成 DTO 或令牌。

定义满足 WebPlugin 的对象，所有贡献 ID 使用 `<插件ID>.<贡献名>`。面板与组件/模块 mount 接受专属 HTMLElement 和 HostContext，返回 Dispose；异步资源必须处理 context.signal，并用 onDispose 登记事件/定时器等释放逻辑。

v1 升级：apiVersion 改为 2；所有请求显式传信号，成功从 HostResult.data 读取模型，并保留 logId。HostError 包含错误分类、代码、状态、日志 ID 与限流等待值。Operation.input_schema 可为任意 JSON 模式；任务无结果/无错误映射为 null。

WebPlugin.contributions 为兼容的可选字段，包括具名 components、路由 modules、commands、显式版本 services 及 beforeTaskSubmit。extensions 提供公开目录、命令/服务调用、事件、状态；插件专属上下文允许动态 register。状态/发射事件必须使用自身命名空间；host.* 由宿主发布。手动撤销与卸载均收敛贡献。

components.mode 缺省为 append；replace 通过公开 SlotAdapter 获取宿主受控租约。宿主可注入 createNamedSlotAdapter 的具名默认 renderer，替换时释放默认渲染，卸载恢复。没有直接修改宿主私有 DOM；具体 UI 框架由插件自带。json.ts 校验公开扩展输入/输出，拒绝循环引用、类实例和非有限数字。

InstalledWebPackage 为浏览器 SDK 安装目录映射，不是后端 DTO；entryPath 经宿主 PackageEntryResolver 映射至本代 UUID 资源前缀，EsmImporter 注入实际 ESM 导入。设备提供者 API 不在当前契约内。
