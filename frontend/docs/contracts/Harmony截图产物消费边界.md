# Harmony 截图产物消费边界

日期：2026-10-12，UTC。本文同步主代理已批准的 [Harmony 截图实施合同](../../../backend/docs/implementation/Harmony截图插件实施裁定.md)，冻结 SHA-256 为 `812C67A33F9CB99B6E3C97BF5422433A9CDB8F50BE09658BE89DFCC836977E15`，并核对现有浏览器公开接口的消费职责。宿主 JPEG 首阶段资格定点已验；实际截图生产、截图服务、具体页面及真实浏览器/设备验收分别交接。

## 当前结论与批准合同

现有 SDK v2 的可选 `HostContext.devices`、`HostContext.artifacts` 和 `HostContext.taskHistory`，加上已有 `getJob/cancelJob`，足以承接发布后的 JPEG 产物。前端不需要新增平台路由、SDK 类型、HTTP DTO 或接口字段；插件使用前检查可选入口是否存在。

以下为本批已批准实施合同。合同批准只确定实现与验收目标，运行时入口仍须以实际能力目录和设备 availability 为准，不能把批准等同于已经注册或真实截图通过：

| 合同项 | 已批准内容 |
| --- | --- |
| 能力 | `screenshot@1`，`scope=device`、`access=write` |
| 输入与期限 | 插件封套为 `{device_id, input: {}}`，无输入产物；沿同一原绝对截止点的总 `30000ms`，浏览器不覆盖期限 |
| 输出 | 业务值 `null`，唯一 `ArtifactOutput{filename:"screenshot.jpeg"}`，宿主按既有输出授权导入并发布 `image/jpeg` |
| 总目录 | 截图加入后十一贡献/十能力，其中八设备能力、二提供者能力，设备 availability 八项；此前十贡献/九能力证据不能借记 |
| 别名 | `harmony.screenshot` 格式 2，使用 `device_envelope` 输入和 `{"kind":"value","wrapped":false}` 结果投影，原样保留 `{result:null,artifacts:[宿主产物元数据]}` |
| 传输 | 真实 `snapshot_display`、固定前台回执及探测后的 `base64 -w 0` 有界回传，再严格解码并交共享 JPEG 验证器 |
| 远端清理 | 本次所有权、已知 writer/reader 返回、删除成功与目录不存在全部确认，才可认定 `CleanupOutcome::Complete`；不新增公开清理字段 |

JPEG 为本批确定的文件名与媒体合同。普通 `file recv` 缺少逐写硬限额，本批采用 Base64 路线；受限助手属于后续路线。JPEG 上限 64 MiB，远端独占目录及 `DF_CAPTURED`、`DF_READ_DONE` 回执由后端实施和验收。浏览器消费已经发布的产物原字节，不接收远端 Base64、临时路径或工具参数。

## 设备与任务调用

动作前从当前 `devices.snapshot()` 或订阅结果读取完整 `DeviceRef`，使用 `providerId/generation/localId`；能力按实际提供者声明及设备 availability 判断精确 `id/version/scope/access`，并核对设备在线状态。不能仅凭平台名称、旧文档或猜测的操作 ID 开启截图入口。

按已批准合同，`devices.invoke` 的 `deviceId` 使用该引用的 `localId`，`input` 为 `{}`。宿主负责插件调用封套，浏览器不重复嵌套 `{device_id,input}`，不提供输出目录或本地路径，不直接执行 HDC。仅当运行目录实际提供 `screenshot@1`、设备在线且声明匹配时，消费者才可发起调用。

`invoke` 返回 `HostResult<Job>`；成功接纳时保存任务 ID 和该提交请求的 `logId`，继续使用 `getJob(id, signal)` 或可选 `taskHistory.get` 查询。`queued/running` 不是截图完成；只有实际终态及结果通过消费校验后才可交付产物。查询成功仍可能得到 `failed/cancelled`，应保留原始 `Job.error/result`，不根据错误文字或产物文件名推断成功。

可选 `TaskHistoryAccess` 提供 `list({limit?}, signal)`、`get(id, signal)` 和 `events(id, {after?}, signal)`。事件包含 `sequence/jobId/status/timestamp`，并不提供独立设备清理或图像质量证明。历史中的 `input/createdAt` 来自持久化记录，不从当前目录补写旧任务的设备代次、能力或期限。

## 结果与产物元数据

`HostResult.data` 是 `Job`，而 `Job.result` 保留原 JSON。按实际正式合同逐层检查结果对象、业务 `result` 和 `artifacts` 数组，不能把 HTTP 的 `data`、任务结果包装与业务值混为同一层。

正式截图包装是 `{result: null, artifacts: [宿主元数据]}`，唯一产物的文件名为 `screenshot.jpeg`、媒体类型为 `image/jpeg`。持久任务结果中的产物仍采用原 JSON 字段，例如 `id/filename/media_type/size/sha256/created_at`。它们不是自动映射后的 SDK `Artifact`；后者在公开上传返回值中使用 `mediaType/createdAt`。

消费层核对实际发布的产物 ID、文件名、媒体类型、非负安全整数大小、SHA-256 等元数据，再按 ID 下载。不从服务器路径、远端路径或命令输出拼接下载地址；不把文件名当产物 ID；不因浏览器仍持有 Blob 就声称远端资源已释放。

## JPEG 下载与内容核对

`artifacts.download(id, signal)` 返回 `HostResult<Blob>`。现有传输将二进制内容保留为原字节，JPEG 无需另设接口，也不转换为 PNG、字符串或 JSON 封套。Blob 下载成功只证明内容传输完成，不能替代 JPEG 解码、截图尺寸/画面正确性或真实设备验收。

公开 `ArtifactAccess.download` 不自动比对产物大小或 SHA-256。需要完整性校验时，消费者依据任务实际发布的元数据核对 `Blob.size` 和原字节摘要，并保留这次下载的日志 ID；头部或结束标记的最低检查也不等于完整解码或视觉审核。

宿主基础用例已有 `shared/jobs/downloadPublishedArtifact` 的大小和摘要核对，但它是宿主私有模块。浏览器插件不能直接导入该模块、生成 DTO 或 `features` 内部代码来绕过公开 SDK。

SDK 不创建 Blob URL。后续面板如创建 URL，应在替换内容时释放旧 URL，并通过 `onDispose` 登记当前 URL 的释放；图像解码、展示与视觉审核另行实施，当前没有页面或视觉通过证据。

## 日志关联、取消与代次

提交、任务查询、事件查询、取消请求和产物下载各自返回真实请求的 `HostResult.logId`，失败沿 `HostError.logId` 保留。产物下载的日志 ID 来自响应关联头；尚未取得服务响应、本地准入拒绝或预取消时可能为 `null`。任务 ID、产物 ID、事件序号和浏览器代次都不能代替日志 ID，也不构造虚假的服务日志。

每次异步调用显式传 `AbortSignal`。既有实际 HTTP 客户端以取消竞速结束传输和 Blob 读取等待；宿主、插件实例及挂载子作用域合并生命周期信号，撤销后的晚到结果不再交付旧上下文。已取得响应后发现撤销，仍保留已取得的日志 ID；尚未取得的日志不可补造。

下载按产物 ID 调用，不绑定设备 selection。切换设备后，后续面板应主动撤销自己的下载/解码等待或复核当前完整设备引用及显示修订，避免旧内容覆盖新视图；不能认为 `devices.select` 会自动撤销 `ArtifactAccess.download`。

取消下载或任务查询等待不会自动调用 `cancelJob`，不会删除持久产物，也不会证明服务器动作、远端截图写入或可信插件副作用停止。需要取消服务器任务时，显式 `cancelJob` 并重新查询实际终态；取消回执和本地 `AbortSignal` 都不承诺远端回滚。服务器重试或补偿不能由浏览器擅自发起。

提供者卸载/换代会撤销旧设备调用资格。持久产物按 ID 存在时，可以通过新的有效宿主上下文读取，不要求恢复旧提供者 generation；浏览器插件或挂载本身撤销后，其旧 `artifacts/taskHistory/devices` 引用不能继续调用。产物保留时间与删除策略沿服务端实际规则，不能从这项访问能力推断永远存在。

## 远端资源确认边界

截图后端使用 32 位小写十六进制 token 及本次独占的 `/data/local/tmp/deviceforge-screenshot-<token>`，管理 `owner` 与 `screenshot.jpeg`。`DF_CAPTURED` 确认前台 snapshot 返回，`DF_READ_DONE` 确认 Base64 reader 返回；缺回执、未知 cat/wc/writer/reader、回执丢失或删除未确认均保持 `CleanupOutcome::Failed`。本地 HDC PID 退出、一次删除调用或目录暂时不存在，不能替代本次所有权与远端写入/读取返回确认。

当前公开 `Job`、`JobEvent`、`Artifact` 和下载 Blob 没有远端进程退出或目录清理字段。`cleanup_failed` 是既有插件清理失败，不是新增 `Job.status`：Job 按现有宿主优先级保存 `succeeded/failed/cancelled`，清理独立记录 `Complete/Failed`。2026-10-26 同步现行规则：draining 只反映真实在途排空，历史未确认诊断不得阻止独立新截图或真实排空后的同 ID 重载；本次失败仍如实记录，未知提交停止自动重放但保留显式重试。晚到清理不能改写历史终态或新代状态，完整准入规则见[插件清理告警与重试约束](插件清理告警与重试约束.md)。本文不新增 DTO、路由或私自约定的清理字段。

| 前端能够观察的事实 | 能得出的结论 | 尚不能推出的结论 |
| --- | --- | --- |
| `invoke` 成功返回 Job | 服务接纳当前任务并返回身份 | 截图完成、文件已发布或远端资源释放 |
| Job 的实际 `succeeded` 及合法产物包装 | 按正式合同取得成功任务结果和发布元数据 | 原始截图画面正确、共享 HDC daemon 状态或未公开远端清理明细 |
| JPEG 原字节下载和大小/摘要核对通过 | 下载与发布元数据一致 | JPEG 可完整解码、真机画面正确或远端目录已删除 |
| 本地等待取消、Job `cancelled/failed` 或提供者卸载 | 等待/任务/提供者达到相应公开状态 | 远端写入者已退出、本次目录清理完成或设备动作回滚 |
| 后端独立证据确认本次所有权、writer/reader 返回、删除成功与目录不存在 | 后端可按批准合同判断本次清理终态 | 浏览器无需新增字段即可自行观测该事实 |

业务阶段共用原 30 秒截止点；失败或取消首次固定 `cleanup_point = now + 2s`，所有清理共享该点。后台晚到收尾不能续预算或改写成功；前端不能把空 `artifacts`、本地文件删除或客户端退出改写为远端清理完成。

授权输出先登记授权根、预期位置及“未取得本次创建所有权”，再派发 `create_new` worker；实际取得句柄才记录本次所有权，`EEXIST` 没有删除权。失败或取消须等真实 flush、关闭与 worker 终态后，删除本次未交付输出并确认。`finish_output` 同步形成成功 Execution 并交声明，是插件向运行库的交接节点；后续导入、Job 取消优先级和授权目录回收沿既有宿主规则。文件存在或 flush 不等于发布，前端只消费实际发布元数据。

## 本次核对与后续验收

此前只读核对现有 [产物 SDK](../../src/plugin-sdk/artifacts.ts)、[任务历史 SDK](../../src/plugin-sdk/task-history.ts)、[设备 SDK](../../src/plugin-sdk/devices.ts)、[宿主上下文](../../src/plugin-sdk/index.ts)、[产物网关](../../src/app/artifact-gateway.ts)、[HTTP 原字节客户端](../../src/services/api/client.ts)及[插件作用域](../../src/plugins/scope.ts)。调用与日志的既有约定见[插件开发](../guides/插件开发.md)、[日志 ID 与接口消费](日志ID与接口消费.md)。本轮同步已批准合同，并只读审查共享 JPEG 与宿主格式接缝；现有公开 SDK 足够，不新增 SDK 类型或接口。

宿主 JPEG 首阶段最低结构与产物资格的首批 27 项定点由主代理执行通过，记录见 [定点报告](../../../artifacts/harmony-jpeg-targeted-20261012.txt)。共享验证器检查 SOI/EOI、段边界和长度、SOF0/SOF2、SOS、扫描区标记及固定资源上限；此阶段未校验 DQT/DHT 表内部结构或表引用，不执行完整熵解码。首批记录保留为历史，后续扫描边界增量及当前集成计数由主代理统一复验；结构资格不能证明任意 JPEG 可解码、像素正确或实际设备截图成功。

本批前端角色仅修改本文，没有修改生产源码、生成文件、测试或产品外壳。主代理串行完成当前 `generate:api`、`check`、`test`、`build` 四门禁，均退出 0；163 项输入身份前后稳定，原件见[前端门禁记录](../../../artifacts/harmony-screenshot-frontend-gates-20261012.json)。本角色未执行服务、浏览器或真机验收；此前 Android PNG、Harmony 详情/连接以及通用产物的通过证据分别保留，不能转计 Harmony 截图生产、截图服务或真机通过。

本次别名结果裁定采用既有 `{"kind":"value","wrapped":false}`，原样返回宿主包装并保留完整 `artifacts` 数组。静态核对确认格式 2 规则、设备能力绑定准入、`map_result`、`Plan::result` 与任务执行器均允许该选择；`kind:artifact` 会仅返回唯一产物元数据，`kind:value` 配合 `wrapped:true` 则会解包成 `null`，均不符合本次完整包装合同。此次仅调整 Harmony 截图新绑定，不扩公开 SDK、宿主投影语义或其他别名。实际服务仍须对设备动作、直接插件操作与平铺别名三入口的成功结果逐项断言 `result:null`、唯一 `screenshot.jpeg`、`image/jpeg`、完整宿主元数据、原字节下载及历史保留，不能用静态允许或单元数据对象替代服务验收。

后续按批准合同独立核对当前能力目录、设备动作接纳/终态、JPEG 发布/原字节/摘要、每次真实日志关联、取消与换代后的晚到交付、产物历史保留及远端清理证据。实际截图生产与服务仍未验，具体页面继续等待设计稿，图像审核交由视觉子代理；普通文本静态核对不计视觉或真机通过。
