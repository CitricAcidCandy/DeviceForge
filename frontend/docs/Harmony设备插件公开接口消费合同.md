# Harmony 设备插件公开接口消费合同

日期：2026-10-10。状态：前端消费合同已按后端正式最小批次冻结；不是插件实现、浏览器、真实 HDC 或真机通过记录。本文使用 architecture-first 模式，只核对基础用例和公开 SDK；不增加产品 UI、生成类型或平台硬编码分支。

## 迁移范围与当前来源

按[核心设备插件实施裁定](../../backend/docs/Harmony核心设备插件实施裁定.md)，Harmony 首批保留既有发现、包列表、单 HAP 安装及卸载行为，目标为独立设备适配器插件。正式批次为 provider `harmony-device`、插件协议版本 4、设备 API 版本 3，贡献集合固定为 `discover`、`packages`、`app.install`、`app.uninstall`。完整应用管理、Harmony 输入、截图、性能与常驻会话分别迁移和验收，不能由本批四项贡献代表完成。

当前源码中的 `HarmonyDeviceTools` 与 `RemainingDeviceArtifactActions` 是迁移来源；正式消费目标是独立的 `harmony-device` 提供者，不能把来源模块名或 `harmony.*` 旧操作名当作公开 provider ID。本轮没有运行工具或服务。

## 新端口裁定

上述离散能力迁出不需要新增前端 HTTP 或 SDK 端口。已有 `HostContext.devices`、`HostContext.artifacts`、`HostContext.taskHistory` 以及任务与在线插件用例足够；后端在现有 `/api/v2/device-providers`、`/api/v2/devices`、`/api/v2/device-actions` 和任务/产物端口发布真实声明，前端继续按现有适配器映射。SDK API2 与设备提供者声明 API3 是不同版本域。

| 行为 | 公开消费入口 | 输入与输出约束 |
| --- | --- | --- |
| 发现 | `devices.refreshProviders` 后用实际 ID/generation 调用 `refreshProvider` | 读取 `DeviceDirectory`；保留规范 state 与可选 rawState，不在浏览器合成 HDC 原始状态 |
| 包列表 | `devices.invoke`，实际声明的 `packages@1` | `device/read`，预算 `30000ms`；`deviceId` 来自当前完整引用，`input={}`，返回共享 Job |
| 安装 HAP | `artifacts.upload` 后 `devices.invoke`，实际声明的 `app.install@1` | `device/write`，预算 `120000ms`；仅接受 `.hap`、最大 `64MiB`，`input={artifact_id}`，产物 ID 不能替换为本机路径；Job 结果保持宿主实际包装 |
| 卸载应用 | `devices.invoke`，实际声明的 `app.uninstall@1` | `device/write`，预算 `120000ms`；`input={package}`，包名规则和工具成功/失败文本由后端冻结 |
| 历史与日志 | `getJob`、`taskHistory.get/events`、`artifacts.download` | Job 五字段保持；历史不补写当前目录元数据，真实 HTTP 错误保留 code/status/logId |

正式目录必须声明 provider `harmony-device`、协议 4、设备 API 3，以及上述四项贡献和三个 `@1` 能力。浏览器仍不从 `platform='harmony'` 推断目标插件、能力或 operation 名；`capability.operation`、scope/access 和预算均以当前 generation 的公开声明为准，不由浏览器拼出别名。现有规则拒绝能力缺失、版本不匹配、scope 不满足、非 online 或 availability 不满足的动作；预算读取为 `executionTimeoutMs` 元数据，不由浏览器覆盖或重新计算。

## 产物与任务边界

HAP 上传仍使用 `ArtifactAccess.upload(filename, Blob, signal)`；未来可见上传入口依据 `.hap` 文件名和 `64MiB` 限制作提示及提交准入，服务端仍须再次校验，通用公开 SDK 不新增平台输入规则。安装动作通过完整 `providerId/generation/deviceId` 携带 `input.artifact_id`；嵌套产物授权使用现有服务器 pointer 能力，指针为 `/input/artifact_id`。不能回退到顶层字段或传 HDC 执行路径。

前端不复制 HAP 内容资格、摘要、链接/重解析点或工具输出判断；后端负责授权副本、文件工作排空、工具退出与发布。安装输出的公开文件名不能泄漏私有暂存路径。共享 SDK Job 的字段保持 `id/operation/status/result/error`，协议产物包装在 `Job.result` 的 `{result,artifacts}` 中，不能新增 `Job.artifacts`。本批清单 `outputs=false`，四项新贡献仍由宿主协议 4 产生该包装且 `artifacts=[]`；安装业务 `result={artifact_id,output}`，列表和卸载业务 `result={output}`。旧三项能力绑定显式 `value/wrapped=true`，发现使用专用数组投影，不按业务 JSON 外形猜测来源。

成功 HTTP 可能返回最终失败 Job；该情况保留 `Job.error` 字符串，不能伪造 `HostError.code`。caller 或面板取消只结束浏览器等待和交付资格；若需要取消服务器 Job，显式调用现有 `cancelJob` 并查询任务终态。不能据 AbortSignal 认定 HAP 安装回滚或 HDC daemon 已停止。

## 热装卸与旧操作

服务器插件管理沿 `runtime.serverPlugins` 或 `runtime.pluginPackages` 的现有公开用例进行。卸载后操作/提供者缓存与选择失效；浏览器挂载、插件和 runtime 旧引用都应本地撤销。重载必须使用新 generation 和新观测，旧代动作不得复活。`draining/cleanup_failed` 保留后端原值，前端不提前显示清理完成。

旧四入口只有在实际操作目录出现时可兼容消费。若部署者显式绑定旧名，旧输入与结果转换归宿主冻结绑定层；新代码优先 `devices.invoke`。提供者卸载后不回退到内置 HDC，也不自动重放可能已完成副作用的安装/卸载。卸载仍允许读取持久化历史与产物。

## 后续冻结与验证

后端已冻结 provider `harmony-device`、协议 4/API 3、四贡献、三能力 `@1`、三项 scope/预算、`.hap`/`64MiB` 限制、`/input/artifact_id` 指针及无输出实体。发现只保留精确 `[Empty]` 哨兵，合法唯一标识映射 online/rawState=`device`；未知诊断、非法、重复和超限使整次发现失败。包名、工具成功行、固定错误、取消/到期沿原截止点和未确认资源保留规则均按正式裁定实施，仍需真实公开目录与协议/服务证据证明。这些是业务合同输入，不要求新增浏览器端口。

主代理随后按当前构建与实际包分别执行 HTTP/MCP 同 Job/事件、在线装卸、公开 API2 消费、上传 HAP、工具失败、取消/卸载排空和新旧代隔离。模拟 HDC、真实工具/HAP、真机、LAN/npx 分开报告。当前静态结论只证明已有前端接缝可承载本批离散迁移；没有运行服务、浏览器、生成器、构建或生产性能验证。
