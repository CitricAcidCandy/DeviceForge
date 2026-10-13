# 浏览器插件公开契约

作用：SDK v2 独立版本化宿主上下文、生命周期与开放贡献契约，不导入任何宿主模块、生成 DTO 或令牌。

定义满足 WebPlugin 的对象，所有贡献 ID 使用 `<插件ID>.<贡献名>`。面板与组件/模块 mount 接受专属 HTMLElement 和 HostContext，返回 Dispose；异步资源必须处理 context.signal，并用 onDispose 登记事件/定时器等释放逻辑。

v1 升级：apiVersion 改为 2；所有请求显式传信号，成功从 HostResult.data 读取模型，并保留 logId。HostError 包含错误分类、代码、状态、日志 ID 与限流等待值。Operation.input_schema 可为任意 JSON 模式；任务无结果/无错误映射为 null。

主题是可选的 `HostContext.themes` 与 `PluginContributions.themes` 扩展，使用显式选择、运行代次和可释放订阅。变量/CSS 限额、目标节点与基础样式恢复见 [主题插件与宿主样式](../../docs/主题插件与宿主样式.md)。

WebPlugin.contributions 为兼容的可选字段，包括具名 components、路由 modules、commands、显式版本 services 及 beforeTaskSubmit。extensions 提供公开目录、命令/服务调用、事件、状态；插件专属上下文允许动态 register。状态/发射事件必须使用自身命名空间；host.* 由宿主发布。手动撤销与卸载均收敛贡献。

components.mode 缺省为 append；replace 通过公开 SlotAdapter 获取宿主受控租约。宿主可注入 createNamedSlotAdapter 的具名默认 renderer，替换时释放默认渲染，卸载恢复。没有直接修改宿主私有 DOM；具体 UI 框架由插件自带。json.ts 校验公开扩展输入/输出，拒绝循环引用、类实例和非有限数字。

InstalledWebPackage 为浏览器 SDK 安装目录映射，不是后端 DTO；entryPath 经宿主 PackageEntryResolver 映射至本代 UUID 资源前缀，EsmImporter 注入实际 ESM 导入。

models.ts 定义共有 JSON、HostResult/HostError、Operation 与 Job，index.ts 保持公开重导出；devices.ts 定义独立设备模型和 DeviceAccess。HostContext.devices 是 apiVersion 2 可选加法字段，旧宿主可省略。refreshProviders/refreshDirectories/refreshProvider/invoke 返回 HostResult；select/snapshot/subscribe 提供选择与观测，subscribe 返回 Dispose。DeviceRef 使用 providerId/generation/localId，DeviceAction 使用 providerId/generation/deviceId/capability/version/input；HTTP 字段只由宿主显式映射。

设备提供者声明支持 API 1/2/3，独立于浏览器 HostContext 的 apiVersion。每项 DeviceCapability 的可选只读 executionTimeoutMs 对应生成 HTTP execution_timeout_ms：设备声明 API 2/3 可给出 1–120000 毫秒，API 1 不能声明非空值。缺省和 null 均映射为字段省略，由宿主采用 30000 毫秒；SDK 不补默认值或裁剪预算。此字段是能力目录元数据，DeviceAction 和 invoke 不增加浏览器覆盖参数，AbortSignal 不改变服务端总预算；发现自身仍统一采用 30000 毫秒。

ProvidedDevice.rawState 是设备 API 3 的可选只读原始状态，HTTP raw_state 由 app 原样映射。API 1/2 缺失或 null 归 None，非 null 拒绝；API 3 缺失/null 同样省略 SDK 属性，有效原文最多 100 UTF-8 字节、非全空白且无 Unicode 控制字符，不 trim、改大小写或截断。合法未知原文可供说明，动作仍按四值规范 state 与能力可用性准入；原文不授予特殊模式能力。raw 随整份观测替换或撤销，不从上一轮、旧代或历史 Job 补值。

本轮 F01 源码和回归已交接，生成类型、前端门禁与真实浏览器由主代理统一执行；不以本文接口说明宣称三入口统一发现、绑定格式 2 或本轮生产链路已验收。

刷新开始清旧观测，提供者消失/代变与切换设备拒绝旧结果；实例和面板/组件/模块作用域合并设备请求取消并释放订阅。关闭后所有设备入口拒绝使用。本地准入错误不生成 logId，HTTP 错误保留服务日志关联。当前 SDK 不提供服务器管理或包管理；产物原字节传输由下述可选扩展单独公开，设备页面与常驻会话仍不属于此契约交付。

## 可选产物原字节传输

`artifacts.ts` 定义独立只读 `Artifact`（id、filename、mediaType、size、sha256、createdAt）与 `ArtifactAccess`，通过 index 重导出。SDK v2 可选 `HostContext.artifacts.upload(filename, content: Blob, signal)` 返回 `HostResult<Artifact>`，`download(id, signal)` 返回 `HostResult<Blob>`。旧 API2 宿主可省略此字段，插件需检测是否提供，不补伪实现。

上传由 app 将生成元数据映射为 camelCase；非空 ID/文件名、非负安全整数 size、64 位十六进制摘要及有限非负 createdAt 通过校验后原值保留，不裁剪或伪造。成功日志与 HTTP/协议错误沿 HostResult/HostError.logId 传递。下载包括 JSON、NUL 和非法 UTF-8 在内均保持原字节，不解析业务封套；有响应头日志就保留，无响应日志则为 null。

调用显式传信号，宿主、插件实例和挂载子作用域共同约束等待；退出后零新调用，晚到成功不交付旧代。Abort 不承诺已接纳上传回滚、服务器任务取消或产物删除。SDK 不创建 Blob URL，插件自行创建时必须用 onDispose 登记 URL.revokeObjectURL。artifacts 端口无元数据查询、ZIP 预览、产物删除或管理入口；任务列表/事件通过下述独立可选扩展开放。产物门禁与真实浏览器由主代理另记，旧 LAN 报告不作为该加法验收。

## 可选任务历史与状态事件

`task-history.ts` 定义独立 `HistoricalJob/JobEvent/TaskHistoryAccess`，index 公开重导出。API2 可选 `HostContext.taskHistory` 提供 `list({limit?}, signal)`、`get(id, signal)`、`events(id, {after?}, signal)`，均返回 HostResult；list/events 的 data 为只读数组。未注入时保持字段省略，不改变原 Job、getJob、提交和取消签名。

HistoricalJob 在 Job 上仅增加持久化 `input/createdAt`；事件为 `sequence/jobId/status/timestamp`。时间为非负安全整数 Unix 毫秒，序号为正安全整数；同次事件严格升序、全部大于 after，并精确关联请求 jobId，允许序号间隙与非单调时间。limit 的显式范围为 1..200，after 为非负安全整数，省略时交给服务器默认。标识保持原文，get 校验响应 id 精确匹配。历史不从当前操作、预算、设备或提供者代次补字段。

本地查询错误为 protocol/invalid_history_query；映射错误分别为 invalid_history、invalid_job_events，沿 HostError 保留真实响应 logId。caller、宿主及插件/挂载作用域取消会及时拒绝等待，即使注入端口忽略信号；晚 resolve/reject 安全消费，旧代引用不复活，已交付结果不撤回。查询撤销不删除历史或调用 cancelJob。此扩展无缓存、订阅、自动轮询、日志流或重连器；本批源码与独立回归待主代理统一门禁及生产浏览器验证。

## 普通操作有效总预算

`models.ts` 的 `Operation.execution` 是 SDK v2 可选只读加法字段，`OperationExecution` 随 `index.ts` 既有公开重导出提供：`{ apiVersion: 1, totalTimeoutMs: number, source: 'default' | 'declared' }`。它显式映射生成目录的 `execution.api_version/total_timeout_ms/source`；毫秒数必须为 1–3600000 的安全整数，版本、来源、必填项或未知字段非法时拒绝响应，不猜测或裁剪。shared/api 的独立纯校验负责 wire 规则，app 负责 camelCase 转换。

旧目录缺省/null 都在 SDK 省略 `execution`，前端不补 60000。新版普通目录由服务器明确发布有效预算及 default/declared 来源；特殊设备预算仍由能力目录的 `executionTimeoutMs` 表示，两者不相互继承。查询与订阅使用同一映射；协议错误沿 `HostError.logId` 保留真实响应日志。

该元数据不增加 submit、业务 input、Job、事件或设备动作参数，浏览器不能通过它延长服务器总期限。历史 Job 不从当前目录补预算，也不随同 ID 操作重载套用新声明。LONG-FE 已补兼容、严格校验、日志、提交原样及历史不补值回归源码；生成类型与 check/test/build 由主代理统一，本文不宣称本批门禁或真实长执行已通过。
