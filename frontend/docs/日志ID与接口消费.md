# 日志 ID 与接口消费

本端已实现 v2 HTTP 适配器及公开 SDK 的 data/logId 与受控错误传播；具体错误展示和复制交互尚未实施。main.ts 未装配产品 runtime，页面仍是开发外壳。

## 类型与版本

客户端默认调用 `/api/v2`：业务成功响应为 `{log_id,data}`，失败为 `{log_id,error:{code,message}}`。`shared/api/generated.ts` 由主代理通过 `npm run generate:api` 获取两版接口，业务类型直接索引 paths，组件和插件不得手写重复 DTO。v1 关联头约束保留在协议中，当前客户端未提供 v1 调用适配。

产物内容下载保持原字节，包含 JSON 类型文件；不能把下载 JSON 当作业务响应拆包。OpenAPI 文档保持标准结构，在根部 `x-deviceforge-log-id` 扩展返回 ID。所有宿主响应都提供同名关联头。

## 适配与交互

`shared/api` 已统一拆包，将日志 ID 保留在 ApiResult/ApiError 中，HostContext 映射为 HostResult/HostError。响应业务结构、包装和关联头不一致会受控拒绝。页面只消费映射后的业务数据和日志 ID，不承担响应版本识别、不读取服务器日志路径。

任务提交 ID 与日志 ID 分别保存；后台执行沿用提交请求的日志 ID，查询和取消各产生新 ID。排查时展示当前失败请求 ID，并保留任务 ID 供查询。请求取消、组件销毁和设备切换仍须处理晚到结果。

后续错误展示应支持选择和复制日志 ID；禁止把部署令牌、请求原文或服务器私有路径作为错误详情展示。MCP 客户端成功从 `result._meta["deviceforge/log_id"]`、协议失败从 `error.data.log_id` 读取，当前前端 runtime 不包含 MCP 客户端。

## 验收边界

单元测试已覆盖对象/数组拆包、损坏包装、日志头不一致、401/429、忽略信号的网络取消、原始 JSON 产物及晚到结果；管理变更不自动重试。主代理 debug/release 真实浏览器已验证在线包、命令/任务调用保留日志 ID，见根 artifacts/browser-plugin-smoke-debug.json 与 browser-plugin-smoke-release.json。

设备第一阶段 HTTP/SDK 适配已实现，行为测试覆盖冻结错误码/状态、真实响应 logId 和本地取消/准入错误。服务刷新返回的 cancelled 属于带日志 ID 的 HTTP 错误；本地取消属于取消分类，本地准入错误 logId 为 null，不能伪造服务日志 ID。设备最终浏览器证据由主代理独立汇总；日志复制 UI、v1 客户端和产品设备页面仍未实施，真机与常驻会话不由此前在线插件证据替代。
