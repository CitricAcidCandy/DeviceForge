# Harmony 设备插件公开接口消费合同

## 2026-10-12 连接与断开消费合同

下一批已裁定新增 `connect@1`、`disconnect@1`，均为 `scope=provider`、`access=write`，总预算 `30000ms`，目标为十贡献、九能力；本节记录冻结合同和前端接缝，不借用详情批次证据宣称连接已通过。完整边界见 [Harmony 连接与断开插件实施裁定](../../../backend/docs/implementation/Harmony连接与断开插件实施裁定.md)。提供者动作不进入每台设备的 availability，发现仍只声明七项设备能力。

| 行为 | 公开调用建议 | 观测边界 |
| --- | --- | --- |
| 连接未发现地址 | `refreshProviders` 获取当前提供者及其精确能力后，通过 `devices.invoke` 携带 `providerId/generation`、`deviceId:null`、实际声明的 `connect@1` 和严格 `input:{address}` | 不要求已有设备目录或已选择设备；不伪造 `DeviceRef`，不把地址放入 `deviceId` |
| 断开地址 | 同一公开入口使用实际声明的 `disconnect@1`、`deviceId:null` 和严格 `input:{address}` | 允许针对未观测或已离线的地址提交，不依赖设备 `online` 或 availability |
| 重新观测设备 | 连接或断开终态后显式调用 `refreshProvider`，从真实新目录读取设备引用、状态和能力 | 动作本身不刷新目录、不改变选择，也不能在浏览器合成 online 或直接删除旧条目 |

服务器插件封套严格为 `{device_id:null,input:{address}}`，所有字段必须显式提供；业务输入不接受端口分字段、额外命令、设备标识或工具路径。地址最多 `21` 字节，仅接受规范点分 IPv4 或字面小写 `localhost` 加显式端口；IPv4 每段为 `0–255`，不得带前导零；端口为 `1–5` 个 ASCII 十进制数字且数值为 `1–65535`。其他 DNS、IPv6、裸 IP、空白、控制字符和选项形状拒绝。`localhost` 字面值交给 HDC，不由浏览器改写为 `127.0.0.1` 或据此猜测发现后的 localId。

| 能力 | 固定 HDC argv | 成功业务 JSON |
| --- | --- | --- |
| `connect@1` | `[tconn,address]` | 新连 `{output:"Connect OK"}`；重复已连 `{output:"[Info]Target is connected, repeat operation"}` |
| `disconnect@1` | `[tconn,address,-remove]` | 零退出、两流均静默时 `{output:""}` |

两项命令均不带 `-t`，断开不使用 `-r`，每 Job 只有一条连接管理命令；不自动发现、重试或补偿。两流要求 UTF-8 且各最多 `1MiB`，失败诊断优先于成功或静默；找不到断开目标的 `[Fail]No target available` 是失败。未知响应、乱码、超限和非零退出不发布成功对象。结果沿协议 4 使用 `Job.result={result:业务JSON,artifacts:[]}`，不增加在线状态、目录、设备引用或产物字段。

格式 2 新增示例别名 `harmony.connect`、`harmony.disconnect` 仅接受 `{address}`；宿主以 `device_envelope` 生成显式 null 封套，`value`、`wrapped=true` 提取业务结果，仍只产生同一个 Job。它们是本批新增别名，不代表已验证的旧宿主兼容。新代码继续优先 `devices.invoke`。

现有 SDK `DeviceCapability.scope` 已支持提供者与设备两种范围，`DeviceAction.deviceId` 支持显式 `null`。基础用例对提供者能力只校验当前提供者代次、精确能力版本、范围和合法 JSON 对象输入，不要求设备观测；对设备能力仍要求本代目录、online 和 availability。HTTP 适配器继续映射现有 `/api/v2/device-actions`，因此此方案无需扩充 SDK、生成类型、平台分支或产品页面。

提供者调用沿既有插件实例、挂载子作用域与宿主取消资格；提供者卸载或换代撤销旧等待。提供者动作不绑定当前所选设备，切换设备本身不自动取消连接调用，面板需要按自己的流程显式取消。取消浏览器等待、任务完成或插件卸载都不能直接解释为远程连接回滚或共享 HDC daemon 已关闭。新调用优先使用 `devices.invoke`；若后端发布旧别名，其输入转换和结果投影由实际绑定契约决定，不在浏览器补造别名。

排队、提供者写屏障、配置、工具及结果发布继承同一 `30000ms` 原截止点，不使用 Android 连接的 `5000ms` 工具短限额。连接可能在 caller 取消后继续存在；没有显式刷新时目录保留的旧状态不能证明本次连接或断开效果。

前端公共接口回归位于 `tests/provider-actions.test.ts`，主代理串行定点 `6/6`、严格检查 `112` 个源码且 Svelte 零错误/零警告、完整测试 `308/308`、`166` 模块构建均退出 `0`，见 [本批前端门禁记录](../../../artifacts/harmony-network-frontend-gates-20261012.json)。该结果证明无目录的提供者动作、显式 null、旧代撤销、caller 取消、选择切换和手动刷新接缝，不证明真实 HDC、常驻会话、真机或连接稳定性。API 生成仍待后端读入集冻结后由主代理运行；当前没有修改生产源码、SDK 或生成文件，后端协议、连接服务与正式分发继续分别验收。

## 2026-10-12 应用详情读取增量

后端已实现 `app.detail@1`，当前清单为八个贡献、七个设备能力；本节记录前端消费边界，真实 HDC 与 Harmony 设备仍待验收。能力为 `device/read`，总预算 `30000ms`，与既有设备引用和任务生命周期共用宿主截止点，业务裁定见 [Harmony 应用详情插件实施裁定](../../../backend/docs/implementation/Harmony应用详情插件实施裁定.md)。

| 能力 | `DeviceAction.input` | 固定工具与结果语义 |
| --- | --- | --- |
| `app.detail@1` | 严格 `{bundle}`；设备动作封套仍为 `{device_id,input}`，不得增加或改写业务字段 | 固定执行 `[-t,device_id,shell,bm,dump,-n,bundle]`；成功结果为完整 JSON 对象，保留未知字段、数组、`null` 和嵌套对象 |

浏览器只从当前 `harmony-device` generation 的公开 capability、scope/access、版本和预算消费该入口，不按平台名称拼接 operation，也不持有 HDC 路径或重置详情查询期限。公开查询要求根值为对象；不要求 `hapModuleInfos`、`mainAbility` 或其它启动专用模块字段，自动启动时的首模块推导仍属于 `app.start@1` 的后端内部流程。

后端解析允许纯 JSON 对象，或带精确 bundle 标题的 JSON 载荷；stdout/stderr 按 UTF-8 读取且各流最多 `1MiB`。重复键、尾随内容、超过 `64` 层或 `100000` 节点、非对象根、无效编码、精确失败诊断标签和工具失败均拒绝整次调用，不发布部分详情。根 `name` 字段存在时必须与请求 bundle 一致；公开查询不校验模块 `bundleName`。合法 JSON 字段中的普通文本只作为数据保留，不能被浏览器当成工具诊断。具体标题匹配和错误码以当前后端裁定与协议响应为准。

成功任务继续使用共享 Job：`Job.result={result:完整详情对象,artifacts:[]}`，不新增 `Job.artifacts` 或平台专用 DTO。现有 `publicJob` 仅校验 `isJsonValue` 后原样返回结果，因此公开 SDK、`devices.invoke`、`getJob` 和任务历史能够承载未知字段；该 JSON 守卫拒绝循环引用、类实例和非有限数值，业务解析限额由后端负责。兼容旧格式 2 别名 `harmony.app.detail` 时，宿主绑定层将扁平输入转换为设备封套，并以 `value`、`wrapped=true` 提取同一个完整对象；新代码优先使用 `devices.invoke`。详情消费不增加产品页面、手写 HTTP 路由或生成文件。

日期：2026-10-12。状态：后端库 `39/39`、独立协议 `57/57` 通过；架构、规则测试、格式、完整 Clippy、完整 workspace 测试及 debug/release 构建均退出 `0`，见 [本批后端门禁记录](../../../artifacts/harmony-detail-backend-gates-20261012.json)。主代理已重跑前端生成、严格检查、`302/302` 测试与构建；当前没有新增前端生产实现或平台专用 DTO。

真实 debug 宿主与假 HDC 的 [本批 debug 服务报告](../../../artifacts/harmony-device-smoke-debug-6ce1a8c9-339a-4600-8ee1-14807c3c355f/report.json) 为 `passed=true`，`38/38` 检查、`83` 个 Job、`89` 次工具调用，包含详情三入口/HTTP 与 MCP、完整对象保留、非法输入与解析失败、读取并行、取消、旧代拒绝及重载历史。报告确认输入稳定、宿主正常退出 `0` 和端口释放；主代理已交付 [本批 release 服务报告](../../../artifacts/harmony-device-smoke-release-7ca4bbe0-b65c-477e-8eaa-9453f3b787ae/report.json) 的 `passed=true` 终态。这些是假 HDC 服务证据，不是浏览器详情交互或真机证据。

当前八贡献/七能力的正式包与 [npx 分发报告](../../../artifacts/npx-raw-FUAAaf/report.json) 已通过并完成独立审核：`36` 个 Job、`108` 条事件、`40` 次假 HDC 调用；`43` 项输入与 `91` 项保留业务原件复核零差异，两阶段均正常退出 `0`，两个监听端口释放。该证据覆盖本批完整详情对象，不借记旧七贡献版本，也不覆盖下一批连接/断开。真实 HDC、Harmony 设备、浏览器详情交互及生产性能仍分别待验。

## 2026-10-12 应用启停与数据重置增量

当前实施范围新增 `app.start@1`、`app.stop@1` 和 `app.reset@1`，均为 `device/write`，总预算 30000 毫秒；同一设备与安装、卸载共用宿主写互斥。提供者保持 `harmony-device`、协议 4 和设备 API 3，清单增为七贡献、六能力。下文四贡献、三能力记述保留首批历史范围，新批验证以根交接及当前报告为准。

| 能力 | `DeviceAction.input` | 基础用例语义 |
| --- | --- | --- |
| `app.start@1` | `{bundle,ability?}` | 显式 Ability 或省略后由服务器查询同包详情，按旧行为读取首模块 `mainAbility`；查询和启动共用一次调用截止点 |
| `app.stop@1` | `{bundle}` | 强制停止应用，成功只证明工具返回对应成功行 |
| `app.reset@1` | `{bundle}` | 清除应用数据；具体产品界面后续须清晰表达该动作效果 |

浏览器仍从当前提供者目录读取 capability、generation、scope/access 和 availability，不按平台名称推断入口，不持有 HDC 路径，也不为详情查询重置总期限。`bundle` 为最多 200 字节的点分 ASCII 标识；显式 `ability` 为最多 200 字节的单段或点分 ASCII 标识，空值和 `null` 均无效。动作通过已有设备基础用例提交；不新增手写 HTTP DTO、不改通用路由、不增加产品页面。

任务成功的 `value` 为 `{output}`，不创建产物；停止、重置和启动都不证明设备侧事务回滚、实际桌面变化或进程持续存活。具体界面、真实 Harmony 设备和实际 HDC 格式仍独立验收。业务规则及旧源码取证见 [后端实施裁定](../../../backend/docs/implementation/Harmony应用启停与重置插件实施裁定.md)。

日期：2026-10-10。状态：前端消费合同已按后端正式最小批次冻结；不是插件实现、浏览器、真实 HDC 或真机通过记录。本文使用 architecture-first 模式，只核对基础用例和公开 SDK；不增加产品 UI、生成类型或平台硬编码分支。

## 迁移范围与当前来源

按[核心设备插件实施裁定](../../../backend/docs/implementation/Harmony核心设备插件实施裁定.md)，Harmony 首批保留既有发现、包列表、单 HAP 安装及卸载行为，目标为独立设备适配器插件。正式批次为 provider `harmony-device`、插件协议版本 4、设备 API 版本 3，贡献集合固定为 `discover`、`packages`、`app.install`、`app.uninstall`。完整应用管理、Harmony 输入、截图、性能与常驻会话分别迁移和验收，不能由本批四项贡献代表完成。

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
