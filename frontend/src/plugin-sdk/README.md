# 浏览器插件公开契约

作用：约定宿主上下文、插件生命周期与面板贡献。适用于第三方浏览器扩展的后续实现。

快速开始：定义满足 `WebPlugin` 的对象，面板 ID 使用 `<插件ID>.<面板名>`；调用 `validateContributions` 验证重复贡献。当前仅提供契约和校验，不提供插件动态加载器。

API：`WebPlugin` 包含 `id/version/apiVersion/panels/activate/deactivate`；`PanelContribution.mount(target, context)` 返回卸载函数；`HostContext` 暴露查询操作和任务提交、读取、取消，支持 `AbortSignal`。宿主不得向插件暴露服务令牌。后续以生成的 HTTP 类型完善具体客户端适配器，当前接口类型是插件契约，不是完整后端 DTO。
