# Harmony 应用启停与重置插件实施裁定

日期：2026-10-12。模式为 architecture-first，验证采用 Hybrid：先证明纯输入、固定参数和失败拒绝，再验证独立协议进程与宿主共享锁，最后执行分发和真机验收。本批三项离散写能力、自动 ability 首模块推导与清理复用均已由主代理批准，本文是冻结实现依据，不表示门禁已经通过。

## 目标、取证与边界

在独立 `harmony-device` 插件新增 `app.start`、`app.stop`、`app.reset`，设备 API 3、能力版本 1、`scope=device`、`access=write`、每项总预算 30000 毫秒。发现目录同步声明六项可用能力，清单变为七贡献、六能力。宿主既有能力注册、设备写互斥、任务生命周期和协议 4 继续承担通用职责，不修改公开 SDK 或 HTTP/MCP 路由。

旧工程仅用于只读取证：

- `src/renderer/ApkTool/src/consts/HdcCommand.ts:64`：启动 `aa start -a {ability} -b {bundleName}`；对应注释明确成功响应为 `start ability successfully`，失败为 `error: failed to start ability.`。
- 同文件 `:72`：停止 `aa force-stop {bundleName}`；成功响应为 `force stop process successfully.`，失败为 `error: failed to force stop process.`。
- 同文件 `:82`：重置 `bm clean -d -n {bundleName}`；成功响应为 `clean bundle data files successfully.`。
- `src/renderer/ApkTool/src/script/deviceDebug/hdc/app.ts:44`：详情固定查询 `bm dump -n {bundleName}`，移除同包名标题行后解析 JSON；`:62` 的启动在 ability 省略时查询详情并读取 `hapModuleInfos[0].mainAbility`。
- `src/renderer/ApkTool/src/script/deviceDebug/hdc/types/app.d.ts:33` 与 `:78`：`mainAbility` 是字符串，`hapModuleInfos` 是模块数组。此处是旧源码形状证据，未取得真实设备输出样本。

本批不迁移独立应用详情公开操作、module 选择、`mainElementName` 推导、降级安装、保留数据卸载、设备连接、亮灭屏、输入或常驻会话。动作成功仅表示对应 HDC 命令返回明确成功响应，不证明桌面变化、进程持续存活、数据回滚或共享 daemon 被清理。

## 路径与职责

选择独立 `applications` 业务模块，并复用原 `Control` 进程与清理租约。把业务推导追加到通用宿主路由会扩大平台耦合；把模型、输出判断、JSON 推导和进程等待堆入 `operations.rs` 会混合职责，均不采用。

| 单元 | 负责与输入输出 | 不负责 | 副作用 |
| --- | --- | --- | --- |
| `applications/models.rs` | 严格业务输入对象 | 设备封套、工具执行、任务锁 | 无 |
| `applications/rules.rs` 与 `applications/details.rs` | ability 资格、独立成功行、详情 JSON 到首模块能力名 | 工具、设备、宿主实体 | 无 |
| `applications.rs` | 固定 argv、详情查询与启动两阶段编排、`{output}` 结果 | HTTP/MCP、产物、宿主锁 | 只调用公开工具边界 |
| `operations.rs` | 短贡献识别、严格设备封套、委派应用模块 | ability 推导细节 | 既有编排 |
| `control` | 原调用截止点、进程租约、最多一个阻塞工作、固定清理点 | 平台命令与 JSON 规则 | 工具与工作线程 |
| 清单、别名、发现 | 三项写能力和旧操作绑定 | 启动 HDC、自动 fallback | 无 |
| 库与协议测试 | 输入拒绝、参数、输出、两调用及截止点 | 宿主服务、分发、真机 | 独立假 HDC 进程 |

## 显式输入、固定命令与结果

设备动作封套固定为 `{device_id,input}`，拒绝未知、缺失和错误类型字段。`device_id` 继续使用现有最多 200 字节 HDC 标识规则。停止与重置的业务输入是 `{bundle}`；显式启动是 `{bundle,ability}`。

`bundle` 复用现有最多 200 字节点分 ASCII 包名规则。ability 最多 200 字节，只接受单段或点分 ASCII 标识：`[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*`。原文保留，不接受空值、空白、控制符、选项或 shell 字符，不以字符串拼接运行 shell。

| 动作 | 追加在 `[-t,device_id,shell]` 后的独立 argv | 独立完整成功行 |
| --- | --- | --- |
| 启动 | `[aa,start,-a,ability,-b,bundle]` | `start ability successfully` |
| 停止 | `[aa,force-stop,bundle]` | `force stop process successfully.` |
| 重置 | `[bm,clean,-d,-n,bundle]` | `clean bundle data files successfully.` |

三个动作均要求零退出、两流 UTF-8、既有失败诊断优先，且某个独立完整行精确等于本动作成功语句；仅允许大小写和行首尾空白兼容，不接受未知前缀、后缀或其它动作成功语句。业务返回 `{output}`，不创建输入副本、私有目录或输出产物。失败使用既有固定错误，不公开失败原始工具文本。

### HDC 的零退出失败标签

2026-10-12 本机 `E:\OpenHarmonyHdc\12\toolchains\hdc.exe` 对明确不存在目标的 `[-t,DF-NONEXIST,shell,bm,dump,-a]` 返回 `[Fail]Not match target founded, check connect-key please`，HDC 退出码为 `0`。原始调用与终端诊断保存在 [本轮取证](../../artifacts/harmony-hdc-fail-diagnostic-20261012T101839Z.json)。该证据只说明真实客户端的不存在目标失败，不作为真机业务通过。

共享 `rules::text` 必须将大小写无关的精确 `[Fail]` 标签识别为失败，允许标签前存在客户端前缀；无论标签在 stdout 或 stderr，均优先于成功行并返回固定 `工具依赖失败：HDC返回失败诊断`。不扩大成任意 `fail` 子串，`com.fail.example` 与 `[Failover]` 等普通业务文本不因本次增量而失败。自动启动详情的 stderr 同样检查该标签，失败后不启动第二条命令；合法详情 JSON 字段中的文本继续作为数据处理。

本次补充库和独立协议回归，覆盖三项应用动作与安装、卸载、列表的失败优先、两流、大小写和合法子串，响应不公开原始诊断。修补不改变成功语句、请求、预算、清理、宿主路由或测试看门狗；执行门禁由主代理另行串行记录。

格式 2 别名为 `harmony.app.start`、`harmony.app.stop`、`harmony.app.reset`，平铺设备与业务字段，经 `device_envelope` 转换调用同名版本 1 能力；结果使用 `value` 和 `wrapped:true`。绑定缺失、插件卸载或旧代调用时不回退到内置 HDC。

## 省略 ability 的两阶段启动

启动业务只要求 `bundle`。省略 `ability` 才进入自动查询；显式 `null`、空串或错误类型均失败，不把非法值当作省略。第一阶段 argv 为 `[-t,device_id,shell,bm,dump,-n,bundle]`，只解析 stdout 的纯 JSON 对象，或首行精确 `${bundle}:\r\n` / `${bundle}:\n` 后的 JSON。未知标题、诊断前缀、尾随内容或重复键整份失败；stderr 先检查 UTF-8 和失败诊断，不将合法 JSON 数据中的 `failed` 等词误当作工具错误。

解析使用公开 `data-codec`，其边界为 64 层、100000 节点；HDC 公共工具执行器继续限制每流最多 1 MiB。`hapModuleInfos` 必须是非空数组且最多 128 项，首项必须为对象并具有合法字符串 `mainAbility`。可选根 `name` 和首模块 `bundleName` 存在时必须等于请求包名。

选择规则保留旧实现的 `hapModuleInfos[0].mainAbility`。后续模块只受总体结构和数量限额，不因其能力名不同拒绝合法多模块应用，也不改为搜索第一个非空入口、猜测 entry 模块或使用 `mainElementName`。缺首模块、缺主能力、主能力无效或包名不匹配均返回固定依赖错误，不发布部分详情或启动第二命令。现阶段只有旧源码形状和模拟输出证据，真实系统版本的输出仍待实机核验。

配置、第一条工具命令、受限阻塞解析、第二条启动命令和最终结果全部使用同一协议 4 `InvocationContext.deadline()` 与同一 `Control` 租约。第一条 HDC 实际退出并确认后才解析；解析工作真实返回且再次通过截止点和取消检查后才允许启动第二条 HDC。中途取消或到期不能续期，不能丢弃解析工作并声明已经释放资源。

原安装 `Session::work` 仅薄委派到 `Control::work`。工作线程持原 one-slot、租约和只读取消回调至真实返回；Future 丢弃、异常、清理到期继续保留粘性未确认和同一个首次固定清理点，不创建应用专用后台线程或新的清理窗口。

## 写集与最小验收

后端角色独占 `backend/plugins/harmony-device/` 和本文；宿主、公开生成文件、根记录、服务构建与分发由主代理负责；真实服务驱动 `scripts/harmony-device-smoke.mjs` 与所属目录由测试角色负责，写集不重叠。

1. 纯输入与解析：省略和显式 ability、包名与字符上限、缺失/额外/错误字段、首模块选择、标题兼容、重复键、尾随、包名匹配与结构限额。
2. 独立协议：三项固定 argv、完整动作成功行、失败优先、UTF-8、非零退出、每流上限、零预算、真实 PID 取消退出和无产物；自动启动核对先查询、真实退出、再启动，失败与到期不启动后续命令。
3. 保留原安装与资源测试：单槽、原租约、工作线程异常、Future 丢弃、固定清理点和私有目录删除结果，不以新动作通过代替原安装回归。
4. 宿主真实服务：HTTP/MCP 和别名经过同一 provider，三项 device/write 与安装/卸载共用互斥，卸载/旧代拒绝、热装卸和无内置回退；debug、release 与正式 npx 消费分别执行。
5. 真实 Harmony 设备：明确设备系统、HDC 版本、详情真实输出形状、默认与显式启动、停止、数据重置、断线和错误行为。模拟 HDC、源码与服务任务成功均不能替代此项。

当前为实现和测试源码落盘，未执行 Cargo、格式、真实服务、分发或真机。最终证据与剩余迁移以根交接和 todo 记录为准。
