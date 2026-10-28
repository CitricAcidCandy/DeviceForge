# 服务器插件调试与验证

## 本机 Debugger：公开合同与验证边界

兼容的 DeviceForge 产品默认随附官方调试器，使用者正常启动并通过本机回环地址打开界面，点击悬浮球选择目标即可，不要求另装 Debugger 或选择验收专用程序。资源市场「已安装」保留启停入口；已有同名独立安装优先。原市场／MCP 本地导入用于被调试插件，或显式替换随附版本。Agent 仍须显式指定实例和插件，不因为有默认入口就采集全部目标。旧宿主缺能力时明确要求升级宿主。

使用部署者提供的兼容 localhost 宿主及实际 MCP 地址，不要求克隆宿主源码、执行内部生成器或构建宿主。调试协议 1 仅接受真实回环连接，并核对本机浏览器来源；普通局域网业务接口保持原规则。先查询 `/api/v2/debugger/capabilities` 与 `deviceforge.debug_targets`，不能把工具存在等同于目标支持全部能力。`production_acceptance_complete=false` 保持不变，真实联调与生产证据另行记录。

- 通过原市场本地导入或原公开 MCP 安装能力导入，不提供独立 `debug_upload/debug_install`，不发布开发包到市场。
- `deviceforge.debug_session` 使用 `action=open,target`，服务器目标为 `target_kind=server` 和真实 `plugin_id/generation`，`instance_id` 省略或为空；版本与代次来自当前目录。`debug_inspect` 读取本代公开操作、服务精确版本、Schema 和可用性，历史清理告警不封锁独立新调用。
- `deviceforge.debug_invoke` 的 `parameters` 支持 `kind=operation/service,id,input,confirmed=true,allow_unknown_side_effects=true`；服务另需精确 `version`，普通操作不接收服务版本。普通操作 ID 使用公开完整名，例如 `plugin.demo_debugger_server.echo`。检查归属及真实代次后只提交原任务，返回原 `job_id/operation/status`，通过原 Job 入口查询终态或显式取消。**服务器不接受 `include_result`**；它仅用于浏览器命令／服务，默认 `false`，显式 `true` 才复制脱敏 JSON。不得以浏览器结果选项改变服务器 Job 模型。
- `debug_reload` 使用 `parameters:{confirmed:true}` 委托原串行排空重载流程，默认 `follow=false`。旧会话 `target_changed` 后，重新查询真实新代次，再用 `debug_session` 的 `action=select,session_id,target` 明确选择或新开会话；旧节点和旧引用不能复用，超时或断线不自动重放。整套安装更新仍走原完整发布入口，不能将运行重载当作完整发布更新证据。
- UI 树、语义查询及节点动作需要明确的浏览器实例。无源码断点、单步、任意脚本执行或私有文件浏览；不要求额外常驻调试进程。结束时只关闭自己的会话。

`deviceforge.debug_events` 支持 `source=logs`，必填 `plugin_id`，可选 `generation/log_id/job_id/session_id/q/order/cursor/limit`；`limit` 为 1–100。持久日志端口在服务器真实日志上先筛选排序再分页，返回 `entries/next_cursor/limited/coverage`，不局限于浏览器最近事件。真实分页及适配器已实现，当前集成源码已向 HTTP/MCP 注入适配器；实际发行版与真实联调仍未由本知识更新验证。无端口时返回 `debugger_diagnostics_unavailable`，不把失败伪装为空列表；游标是不透明值，续页保留原筛选，过期后从首页查询。`source=lifecycle` 仍提供 `session_id/after/limit` 有界生命周期事件及丢弃信息；不带 `source` 的旧请求兼容，不能把事件 `after` 用作持久日志 `cursor`。

`deviceforge.debug_report` 参数为 `{session_id,parameters:{export:'none'}}`，`export` 取 `none/json/markdown`，默认 `none`；可选 `parameters.logs` 携带日志 ID、Job ID、关键词、排序、游标和页大小。返回 `{report,artifact}`，不导出时产物为空，显式导出写入原产物存储，返回元数据和下载 URL。报告保留覆盖、脱敏、限制与代次信息；无产物存储、代次变化或回执未确认时明确报错，不自动重复写入。报告中的浏览器快照目录及 `continuation` 通过 **`deviceforge.debug_ui_tree`** 的 `root_id/snapshot_id/offset/limit` 继续同一冻结快照，沿 `tree.page.nextOffset` 翻页，不将续页参数传给 `debug_report`。服务器目标本身不生成 UI 树。

配套浏览器工具通过公共 `host.debugger@1` 服务消费相同合同：`status/capabilities` 查询、`start` 显式连接、`reconnect` 需 `input:{confirmed:true}`；`call` 携带公开工具 `name/input`；`installation` 查询安装构建；`logs` 仅简单日志 ID／关键词／排序搜索；`focus` 携带明确 `target_kind/plugin_id` 或候选并要求官方面板已启用。可选 `context.debug` 只主动登记语义节点、资源与事件，不读取任意私有状态。

知识随兼容宿主发行，文档更新不表示旧运行服务已升级。独立 Node JSON 协议运行、单元测试和归档闭包只证明对应示例，不证明真实安装、官方面板、浏览器、设备或完整生产闭环。

验证应从独立协议、实际安装、真实宿主调用逐层推进。清单存在、编译成功或模拟工具通过，均不能代替真实设备与真实业务验收。以下步骤适用于自己的插件，不要求修改宿主私有代码。

## 调试流程

1. 在自己的工程运行完整示例，用已知输入核对协议响应。`stdout` 只写协议内容，诊断写 `stderr`；记录请求 ID、局部操作名、协议版本和退出状态，不把原始敏感输入写入日志。
2. 安装并启用后，先通过 MCP `tools/list` 或 `deviceforge.list_operations` 确认目标入口及实际输入 Schema。入口缺失时查询插件或完整发布状态，分别判断未加载、待配置、待依赖和宿主版本不兼容；不通过查找宿主源码猜接口。
3. 调用得到 Job ID 后，用 `deviceforge.get_job` 查询终态、`deviceforge.job_events` 查看相关事件；保留提交与查询各自的 `_meta["deviceforge/log_id"]`。HTTP 客户端读取 `{log_id,data}` 或错误封套，先区分传输失败、输入拒绝与异步任务失败。
4. 对错误核对本次日志和自有插件的 `stderr`，在自己的调试环境复现。未收到响应时说明未取得服务器日志 ID，避免自动重发可能已经接受的动作。需要停止时显式 `deviceforge.cancel_job` 并查询终态；取消客户端等待不代表服务器已经取消。
5. 按自身功能核对输出及产物真实字节、取消、超时、卸载和重新启用。提供者换代或配置修订冲突时刷新公开目录与状态，不复用旧设备引用或盲目重试。调试结果只代表实际使用的宿主、插件包和设备环境。

## 最小功能闭环

1. 按 `examples` 保存完整文件，执行语法或编译检查，再向进程输入请求。核对协议版本、请求 ID、局部操作名、结果和实际零退出；stdout 只出现协议内容。
2. 使用 `npm pack --ignore-scripts` 或准备完整原生 ZIP/TGZ，检查包内入口、相对依赖、清单 ID 与版本；安装器必须接受实际归档。
3. 启动隔离用户根与业务数据目录的宿主，计划并安装完整发布，补齐必要配置后启用。独立示例也可通过旧兼容入口安装、加载；统一发布所属组件不能拆装。通过 HTTP 操作目录或 MCP `tools/list` 确认 `plugin.<id>.<operation>`，不要依赖加载前的缓存。
4. 提交符合输入模式的请求，读取任务最终状态，核对业务结果和真实日志 ID；排队返回成功不等于任务成功。
5. 通过 HTTP 与 MCP 分别完成同一业务输入，确认两者使用共享用例、任务及产物结果；不要把任务 ID、产物 ID 当作日志 ID。
6. 卸载、再次加载同 ID，确认新代际生效，旧调用或设备引用不复活，历史仍可读取。

## 配套浏览器调用

```javascript
const signal = AbortSignal.any([context.signal, callerSignal]);
const submitted = await context.submit('plugin.guide_echo.echo', { message: '你好' }, signal);
const jobId = submitted.data.id;
const current = await context.getJob(jobId, signal);
```

`current.data.status` 为 `queued/running` 时继续按自己的轮询策略查询；`succeeded/failed/cancelled` 为终态。不要在固定一次查询后直接展示执行成功。停止任务需显式 `context.cancelJob(jobId,signal)`，之后继续确认终态；浏览器 Abort 只停止等待，不能推断服务器回滚。

## 失败与资源检查

- 验证缺字段、错类型、未知字段、未知操作、重复贡献、协议不匹配和超限输入被拒绝，且不泄漏原始敏感输入。
- 需要外部工具时覆盖超时、取消、输出超限、非零退出、短帧、错误请求 ID、清理失败及卸载在途任务。所有预算沿同一个绝对期限传递，不能在重试或子调用时重置。
- 协议 3/4 只有匹配响应、真实进程退出及明确清理确认同时成立才算释放；模拟进程被结束不等于外部设备、连接或后代进程已释放。
- 产物覆盖上传、输入副本、输出发布、原字节下载及摘要；公开结果只用产物 ID，不泄漏服务器临时路径。取消或发布失败不保证自动回滚已发布文件。
- 协议 5 单独验证输出序号、EOF、取消、权限与客户端上下文、晚帧拒绝和清理终态，不把普通任务测试当作会话验收。

## 独立工程检查

在自己的独立插件工程执行相关单元测试、类型或编译检查，并核对实际归档；无需获取宿主源码，也无需运行宿主的架构检查、生成器、构建或整套回归。Node 示例可通过独立子进程检查输入输出；选择 Rust SDK 时先取得独立开发包，处理器 API 示意不能当成已编译示例。交付前再在部署者提供的兼容服务中验证实际安装、调用、取消和结果，分别记录已执行与未验证项。

把受检包版本、摘要、宿主版本、输入、输出、日志 ID 和自有进程退出结果记录在自己的验证产物中。不得将模拟设备或一次本机通过扩大为真机、跨平台、局域网另一台主机、正式 registry 分发或生产性能已通过。

## 完整发布专项

验证资源服务器能力探测失败时零上传；GET `/api/v1/capabilities`、CORS 预检、资源 HEAD 的 ETag/长度可供浏览器读取。在线组件、工具和清单全部上传后才允许 catalog 提交；缺资源、错大小、错 SHA-256、部分 marker 或身份不符时目录不出现。同 ID/版本的另一清单在删除、重启后仍拒绝；相同原清单重新上架与旧独立条目兼容分别验证。

在线清单和离线 ZIP 均以原始字节 SHA-256 为修订，分别校验完整闭包，断网离线安装不发网络请求。缺必填输入保持 `configuration_required`；`any_of` 的本地/远端来源分别满足，多个必填组全部满足；敏感空白原值即使遮蔽成 `********` 也不能启用。

核对 `DEVICEFORGE_PLUGIN_RESOURCES` 真实入口、有效配置快照和用户原值不变，高级显式工具路径优先；managed 空根/省略根使用 SDK 仓库，custom 旧合法绝对根保持原内容。重启恢复持久启用意图、expected_revision 冲突、活动/上版/选择/调用租约保护及卸载保留配置逐项复验。浏览器组件是否实际激活、设备和真实工具是否可用仍单独记录。
