# Harmony 输入插件实施裁定

## 1. 状态与当前结论

本文保留2026年10月12日早期取证草案，第10节为随后完成官方取证的当前私有实现合同，覆盖第3至9节未决候选。后端开发仅开放 `src/input/` 私有写集；公共接线、清单、发现及别名由主代理集成。未完成当前编译、独立协议、服务和真机验证前，不计入 Harmony 输入能力完成证据。

早期草案只确认公开设备 API3、协议4、同设备写锁、原调用期限及严格设备封套。后续官方固定版本源码确认了四类输入命令；它们的坐标、滑动速度和文本定位与 Android 语义不同，第10节据此冻结私有模式。不能将 Android `input` 子命令、按键码、`%s`、`--longpress` 或回车66直接改为 HDC 执行后声明兼容。

截图仍按其独立裁定和冻结队列验收；本文不借用截图、Android 输入或旧应用命令的通过数量证明 Harmony 输入可用。

## 2. 本次源码取证

旧工程实际根目录为 `E:\React_Js\Electron\ApkTool`，不是当前重写目录。只读取旧工程，没有修改旧技术索引、源码、工具或配置。

| 来源与位置 | 已确认事实 | 不能推出的结论 |
| --- | --- | --- |
| 旧 `src/renderer/ApkTool/src/script/deviceDebug/hdc/base.ts:13`、`:17`、`:25` | HDC 前缀为 `-t deviceId`，远端执行经过 `shell`，旧实现拼成主机命令字符串再走 IPC。 | 旧字符串拼接不是新插件可直接复制的独立 argv 或文本转义规则。 |
| 旧 `src/renderer/ApkTool/src/script/deviceDebug/hdc/device.ts:110` | 系统版本来源为 `param get const.product.os.dist.version`，并读取名称、厂商及 CPU 信息。 | 产品版本字符串不能证明某个输入工具、子命令、单位或按键表存在。 |
| 旧 `src/renderer/ApkTool/src/script/deviceDebug/hdc/device.ts:139`、`:145` | 亮屏和息屏分别调用 `power-shell wakeup`、`power-shell suspend`。 | 电源命令不是通用按键输入，更不能证明点击、滑动或文本输入。 |
| 旧 `src/renderer/ApkTool/src/consts/HdcCommand.ts:53` | `HdcShellCommand` 包含应用命令、设备信息和亮灭屏，没有四类输入命令常量。 | 不能从命令枚举名称推测官方输入参数。 |
| 当前 `backend/plugins/android-device/src/rules/input.rs:7`、`:32`、`:69` | Android 私有 `Action` 严格区分四种动作、校验边界并生成 ADB 专用子命令。 | 私有 Android 类型及命令规则不是 Harmony 公共 SDK。 |
| 当前 `backend/docs/contracts/设备输入接口.md`、`backend/docs/contracts/安卓设备插件第一批契约草案.md` | Android 已定义 ASCII 文本、设备端引用、部分发送、共享期限和 `dispatched` 的有限含义。 | Android 模拟工具通过不构成 Harmony 真机支持。 |
| 当前 `backend/crates/plugin-sdk/src/devices.rs:5`、`:23`、`:77` | API3 公开版本化能力、device/provider 范围、read/write、能力预算和 `{device_id,input}`。 | API3 不规定平台输入工具，也没有可以直接借用的 Harmony 动作 DTO。 |

旧 `src`、`Tools/hdc`、`doc` 及 `bs` 中，对输入工具字面量 `uitest`、`uinput`、`uiInput`、`harmony.input` 和 HDC 点击、滑动、按键、文本命令的本次定向查询未找到命中。这只说明本次读取范围没有证据，不宣称所有旧分支、外部插件或设备不存在相应功能。

旧命令文件记录的官方导航为 `https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/debugging-commands`；该链接本次未联网读取，不能将其当作已确认的输入语法或版本证据。

## 3. 四类动作范围与未决门禁

| 动作 | 沿用 Android 语义的候选请求边界 | Harmony 必须补齐的证据 | 当前可实现结论 |
| --- | --- | --- | --- |
| 点击 `tap` | `x`、`y` 为0至32767的 JSON 整数；使用当前屏幕方向，不缩放。 | 官方工具和固定子命令、坐标范围、屏幕或显示选择、权限、确定返回规则。 | 可以准备纯请求校验设计，尚不能生成已确认的平台 argv 或发布能力。 |
| 滑动 `swipe` | `x1/y1/x2/y2` 同上；`duration_ms` 为1至10000的 JSON 整数。 | 官方参数究竟为毫秒、速度、采样或轨迹，以及可否准确表达既有时长语义。 | 未确认单位前不能将时长传给速度参数或暗做近似换算。 |
| 按键 `keyevent` | Android 对照为 `key_code` 1至65535，`long_press` 省略为false。 | Harmony 原生按键命名空间、允许表、按下/释放、长按参数和时长、重复行为。 | 不把 Android 数值表或 `--longpress` 当作 Harmony 规则；具体字段边界待冻结。 |
| 文本 `text` | Android 对照为1至1024字节可打印 ASCII，`enter` 省略为false。 | 官方文本工具、焦点要求、字符编码、设备 shell 引用、空格/百分号、回车键语义及命令数量上限。 | 不沿用 `%s` 或回车66；需要新增定位字段或其它输入通道时必须重新裁定。 |

以上是候选兼容目标，不是已实现 DTO 或已批准的 Harmony 模式。若平台不能表达某项语义，应明确调整能力版本或冻结支持范围，不能忽略字段、返回成功却不执行、静默改单位或自动退回 Android 工具。当前四类均未过平台资格门禁，不增加空 `input` 贡献或虚假 availability。

## 4. 官方参数与版本资格

生产实施前为每个支持的工具配置固定语法档案，档案至少记录官方来源、版本或源码提交、精确工具及子命令、必填参数顺序、类型和单位、可选标志、退出码与 stdout/stderr 诊断。部署者仍只配置 HDC 入口；请求不能选择工具、档案、任意 shell、环境变量或追加 argv。

可确认的 HDC 调用前缀仅为 `['-t', serial, 'shell', ...已确认的固定平台参数]`。省略号是未决占位，不是允许传入自由命令。四类输入的完整 argv 当前均未决，本文不编造 `uitest`、`uinput` 或其它工具的 flags，不以本机 HDC 版本替代设备端输入工具版本。

旧系统版本读取只能作为信息观测，不能单独授予输入资格。尚无证据支持最低 HarmonyOS/OpenHarmony 版本、工具帮助探测 argv 或精确帮助输出；这些项须由后续官方固定版本源码或真实设备记录确认。未知版本、工具缺失、权限不足和不匹配档案返回有限固定原因，不能乐观标为可用。

文本必须同时经过宿主独立 argv 和设备端解析资格验证。特殊字符必须按最终档案保留字面量；不能把独立 argv 当作远端 shell 已安全引用的证据。错误及生产日志不回显输入文本或任意工具输出；任务历史仍沿现有请求持久化合同，文本不是秘密输入通道。

## 5. 严格封套与公开接缝候选

候选短贡献及能力为 `input@1`，device/write，`execution_timeout_ms:30000`，实际插件请求形状为 `{"device_id":"HDC001","input":{"action":{"kind":"tap","x":120,"y":300}}}`。复用已有设备 API3 和协议4，不新增 HTTP 请求类型、公共动作 DTO、宿主平台分支或内部依赖。平台私有解析必须在官方语法档案冻结后实施，不能导入 Android 插件私有 `Action`。

封套、`input` 和 `action` 每层都要求对象、显式必填字段且拒绝未知字段。`device_id` 为最多200字节的非空现有 Harmony serial，拒绝null、前导短横线、控制符及自由参数。`kind` 必须是已冻结的四种精确字符串之一；各分支字段独立，不能把其它分支字段忽略。

数值必须是有界 JSON 整数，不接受负数、溢出、小数、数字字符串、布尔、null、数组或对象；可选布尔只能省略或显式true/false，null和其它类型拒绝。动作约束在配置读取、资格探测和 HDC 副作用之前再纯验证。未冻结的按键、长按、文本、回车规则不得先用宽泛模式放行。

输入动作拒绝输入产物，既有清单的安装输入指针及截图输出授权不因此改变。输入自身不请求截图、不创建产物、临时录制或按键回放文件。只有所有已批准子命令、诊断及必要远端退出确认都成立，才返回候选值 `{device_id,action:"tap",dispatched:true}`；宿主协议4包装保留空 `artifacts`。`dispatched` 只表示既定命令完成，不证明焦点、实际应用接收、界面变化或用户目标完成。

若完整四类档案与模式最终批准、实现并验收，才向双清单追加一贡献一能力：Harmony 从十一贡献/十能力变为十二贡献/十一能力，单设备 availability 从八项变为九项；两个 provider 能力继续不进入单设备列表。未知工具资格不授予可用状态，后续发现如何取得有界精确资格记录须单独冻结，不能以在线状态直接推断输入可用。

候选格式2平铺绑定为 `harmony.input`：目标 `harmony-device` 的 `input@1`，`device_envelope` 输入 `{device_id,action}`，`value` 与 `wrapped:true` 提取业务值。仍通过既有能力动作和来源代际，不旁路直接 shell；前端使用公开能力模式和已有 Job/历史接口，不新增产品页面或把按钮显示计为能力完成。

## 6. 共享锁、原期限与取消

HTTP、MCP、直接 Job 及格式2绑定必须解析到相同来源和能力快照。整个输入动作由宿主既有 provider 读屏障与 `provider_id + stable local_id` 设备写锁覆盖，锁键不含 generation；不能让点击、滑动、按键与文本子命令各自重新排队，也不在插件中再造仅单进程有效的共享锁。不同设备可并行，外部 HDC 用户及多宿主实例仍不在此锁范围。

从任务准入起的排队、共享槽、设备锁、模式验证、协议握手、资格探测、全部输入子命令、诊断与结果交付共同消耗既有原总预算。插件只使用公开 `InvocationContext.deadline()` 和取消信号，不按请求接收、工具启动、文本分片、下一按键或新的客户端计时点再给30秒。

取得许可、每笔启动前、下一子命令前及交付前均检查原期限和取消。每路输出保持公开工具默认1 MiB硬限额，采用 Restricted 环境。失败或取消不再发送后续文本、长按释放序列或回车；如果官方档案要求成对按下/释放及补救行为，应明确专门清理规则并先冻结，不能擅自发送可能影响其它用户的全局复位。

输入具有即时外部效果，不是事务且不具备幂等性。失败、超时、取消或断连可能已经发送部分事件，宿主和插件均不自动重试、不回滚已发送内容、不恢复焦点，也不把中途失败写成 `dispatched:true`。

直接 HDC 客户端使用公开进程租约与真实终态确认，未来所选远端前台输入工具也必须明确生命周期：客户端退出不能自动证明远端工具已退出。若需要固定完成帧，应在已确认官方命令外围采用本次唯一标识并验证完整终端帧；具体模板、状态传播、两流合并行为及丢帧后的资源策略待官方工具档案补齐后再冻结，不借用截图回执作为输入确认。

首次可观察失败、取消、到期或等待被丢弃立即固定既有两秒清理点；直接客户端、远端确认及必要工作全部共享同一绝对点，不能先消耗工具相对清理预算再重授两秒。时间耗尽、Future丢弃、真实进程或工作未确认保持粘性 `CleanupOutcome::Failed`，后台仍持租约至实际结束，卸载保留 `draining` 和同ID重载保护。

公开协议4运行库在取消、EOF或期限胜出时优先返回 `操作已取消或宿主连接已关闭` 或 `插件执行期限已到期`，原样保留处理器的 complete/failed清理结果。宿主按既有取消优先级写入实际 Job历史，不因错误文本为取消而把未知资源改成已清理。`CleanupOutcome::Complete` 的范围是已声明工具和资源的确认，不表示已发送事件撤销、共享 daemon关闭或设备界面恢复。

## 7. 生产写集候选与角色边界

当前实际独占写集只有本文。下表是证据门禁通过并经主代理批准后的候选，不构成开始修改生产的许可。

| 角色 | 候选独占写集 | 职责与禁止事项 |
| --- | --- | --- |
| 后端开发 | `backend/plugins/harmony-device/src/input.rs` 与私有子模块、中文README和库测试；批准的 `operations/lib/discovery` 薄接线、双清单与别名示例 | 严格纯解析、固定平台命令、资格档案、有限结果及调用编排；不导入 Android 私有实现、宿主内部类型或复制公开进程库。 |
| 交付总监/测试助理 | `backend/plugins/harmony-device/tests/cases/input.rs`、独立输入假工具及明确划分的支持文件 | 官方档案与独立原帧预期，不用生产构造器生成成功帧、预期argv或expected模式；不改生产、不并行启动共享构建服务。 |
| 前端开发 | 前端公开设备消费、输入模式及历史消费相关文档和其独立验证 | 只用现有provider/generation/capability/input/Job合同；具体产品界面仍等待设计稿，不新增私有DTO或以占位页面计完成。 |
| 主代理 | 共享约束、确有必要的控制接缝、生成器、格式化、构建、服务与分发门禁、根todo及交接 | 按冻结SHA串行集成；控制模块已有接口不足先回流，不能由后端扩大Control或公共SDK写权。 |

官方命令未确定前不编写会运行猜测参数的假 HDC，不创建空业务贡献、不让 `input` 指向通用 echo，也不修改服务器设备分支。后续资格若必须增加远端常驻连接、辅助程序或文件通道，应另过架构和生命周期裁定，不能夹带入本次离散输入。

## 8. 验收门禁与独立证据

1. 官方取证先明确四类动作的完整参数、单位、按键表、文本规则和版本；每条档案带可回读的来源位置。不能用旧常量的注释或本次未读取的公开链接替代。
2. 库测试覆盖逐层严格封套、动作分支、类型/整数溢出/边界、可选布尔null、设备标识注入、未知动作、工具参数不得来自请求以及文本字面量；没有档案的分支保持不可执行。
3. 独立协议4原帧验证Start前拒绝副作用、原期限、各子命令取消/EOF/期限、双流诊断及硬限额、部分发送后不再补普通事件、直接进程实际终态、远端未知保留Failed、清理点不续及Future丢弃粘性。
4. 真实宿主模拟工具验证HTTP/MCP/直接Job/平铺别名共用同设备写锁和来源代际；动作与截图、应用写操作互斥，不同设备可并行；排队与锁等待消耗原预算；卸载撤销准入并在未确认时保持draining。
5. 声明与分发验证双清单同字节、精确input能力版本、贡献/能力/availability数量、其他操作回归、空产物和历史终态；debug、release与真实npx包分别绑定本次二进制和冻结源码，旧包通过不转计。
6. 真实HDC和真机验证工具版本、权限、实际argv、方向/分辨率、滑动时长语义、按键表与长按、焦点/空格/引号/百分号/文本、部分输入与断连后的资源行为。截图观察或模拟工具记录不能替代设备上实际输入效果。

后端完整门禁仍遵守 `backend/AGENTS.md`；本文没有运行Cargo、服务、设备或输入测试，不报告性能结论。库/原帧、模拟宿主、分发、真机和界面效果分别记录，测试助理与主代理共同核对完成范围。

## 9. 主代理下一裁定点

当前具体阻断是缺少四类平台命令与版本证据，不是缺公共DTO或宿主设备路由。请主代理先选择有明确官方源码/帮助输出/真实调用可核对的目标工具档案，补齐滑动单位、Harmony按键码及文本/回车语义，再批准严格动作模式、版本可用性观测和远端完成/未知清理策略。

本节是早期未决记录。当前实现按下一节推进，实际验收仍单独报告。

## 10. 官方取证后的私有实现合同

### 10.1 结构裁定与官方来源

采用 `architecture-first`、Hybrid：先冻结纯模式和官方命令，再并行研发和独立协议验证。影响仅为平台插件私有输入模块、后续薄接线、模式及文档；公开 SDK/API3/协议4和其它平台不变。推荐固定版本 `uitest uiInput` 档案，拒绝把 Android 动作直接复用给 Harmony，也不新增设备端常驻辅助程序。

2026年10月12日直接联网读取下列官方仓库。`testfwk_arkxtest` 的 `OpenHarmony-5.0.0-Release` 当时指向 `3cbc07829899eb71d098b4facb0b08bf75f8541e`；文档仓库指向 `e771923d996724968a5ca0ee364feafe8eff08d7`。以下链接固定提交，分支名和系统产品版本不能替代实际工具资格：

- [输入命令和参数](https://github.com/openharmony/testfwk_arkxtest/blob/3cbc07829899eb71d098b4facb0b08bf75f8541e/uitest/input/ui_input.cpp)：`GetPoint/GetPoints` 拒绝零/负坐标；`SwipeActionInput` 使用像素每秒速度；`TextActionInput` 必须先定位、点击并等待500毫秒；`KeyEventActionInput` 无长按参数。
- [入口、帮助和版本](https://github.com/openharmony/testfwk_arkxtest/blob/3cbc07829899eb71d098b4facb0b08bf75f8541e/uitest/server/server_main.cpp)：版本固定 `5.0.1.1`，普通 `uiInput` 前台执行，不走 `start-daemon`；使用 `uitest help` 探测，避开该版 `uiInput help` 的参数数量实现问题。
- [精确成功诊断](https://github.com/openharmony/testfwk_arkxtest/blob/3cbc07829899eb71d098b4facb0b08bf75f8541e/uitest/core/frontend_api_defines.h)：`ApiCallErr(NO_ERROR)` 的消息是 `No Error`。动作函数打印消息后可能仍返回零，故只检查退出码不够；公共 `rules::text` 的 `error` 子串判定也不适用。
- [文本与事件序列](https://github.com/openharmony/testfwk_arkxtest/blob/3cbc07829899eb71d098b4facb0b08bf75f8541e/uitest/core/ui_driver.cpp)及[系统适配](https://github.com/openharmony/testfwk_arkxtest/blob/3cbc07829899eb71d098b4facb0b08bf75f8541e/uitest/server/system_ui_controller.cpp)：可映射字符逐键发送，其它UTF-8文本通过设备剪贴板和Ctrl+V；注入服务的返回结果并非全部传播到CLI，因此 `dispatched` 不证明应用实际接收。剪贴板内容属于明确外部副作用，不恢复原剪贴板。
- [官方命令指南](https://github.com/openharmony/docs/blob/e771923d996724968a5ca0ee364feafe8eff08d7/zh-cn/application-dev/application-test/arkxtest-guidelines.md)及[原生按键表](https://github.com/openharmony/docs/blob/e771923d996724968a5ca0ee364feafe8eff08d7/zh-cn/application-dev/reference/apis-input-kit/js-apis-keycode.md)：速度范围200至40000、默认600；Enter为2054；只接受文档列出的正整数码，排除未知码-1和CLI不能表达的Fn码0。

| 文件 | 负责 | 不负责 | 输入/输出、副作用 |
| --- | --- | --- | --- |
| `input/mod.rs` | 严格业务解析入口、私有动作和调用编排 | 宿主锁、HTTP、配置、产物 | 设备ID及私有JSON到有限JSON；执行HDC |
| `input/models.rs`、`rules.rs` | 分支字段与有界纯规则 | 进程和异步状态 | 纯动作类型和校验，无副作用 |
| `input/scripts.rs` | 固定平台argv、设备端字面量引用、唯一关联标识 | 请求自选shell或工具 | 合格动作到固定脚本，无设备副作用 |
| `input/receipt.rs` | 独立完成帧、版本/帮助/成功诊断 | 取消和工具生命周期 | 有界双流到有限结果，无副作用 |
| `input/execution.rs` | 原预算下捕获与未确认远端标记 | 新清理预算、设备事件回滚 | 复用Control及公开工具库，副作用有界 |
| `input/observation.rs` | 有界发现资格及明确未完成标记 | 在线状态推断输入可用、并发复刻Control | 最多128台设备，单路HDC观测 |

既有公共文件只做薄接线，由主代理集成；后端不修改截图、Control、公开类型或生成文件。测试研发并行，普通缺陷按冻结批次回流。

### 10.2 精确私有模式

`input@1` 是平台私有业务模式，同名能力不保证各平台动作字段等价。封套仍为 `{device_id,input:{action}}`，三层拒绝未知字段，输入拒绝产物。

| kind | 必填字段 | 可选字段及范围 | 固定子命令 |
| --- | --- | --- | --- |
| `tap` | `x,y` | 坐标均为1至32767整数 | `uitest uiInput click x y` |
| `swipe` | `x1,y1,x2,y2` | 坐标同上；`velocity_pps` 为200至40000整数、省略600；起终点不同 | `uitest uiInput swipe x1 y1 x2 y2 velocity` |
| `keyevent` | `key_code` | 官方按键表中的正整数；不接受 `long_press` | `uitest uiInput keyEvent key_code` |
| `text` | `x,y,text` | 坐标同上；文本为1至1024 UTF-8字节、不含控制符；`enter` 省略false、只接受布尔 | `uitest uiInput inputText x y text`；enter为true时追加 `keyEvent 2054` |

Harmony拒绝 `duration_ms`、Android长按标志、Android回车66、文本`%s`替换以及不带定位坐标的文本请求。设备端引用用单引号及固定的单引号闭合/转义/重开，保留空格、百分号、引号、美元符和反引号原字面量。请求不能选择程序、环境、命令、速度档案或追加参数。

实际执行前重新探测 `uitest --version` 精确版本和 `uitest help` 的四条精确语法；发现阶段需据同样探测填写availability，缺失、版本不合格或帮助不合格返回固定原因，不能根据HDC在线或产品版本乐观授予资格。当前只证明OpenHarmony固定源码档案，不承诺全部华为HarmonyOS商业版本。

当前发现资格单路执行，8秒只限制启动新资格工具；窗口到期不再启动下一设备或下一帮助命令，未完成设备标为 `available:false`、原因 `本次发现未完成输入资格探测`，其它八项能力照常保留。已启动命令继续使用原30秒及同一清理点，不以丢弃Future缩短等待。最多128台设备、零额外任务/独立租约；这是本阶段可观测限制，不声称全部设备输入已验收。后续有界并发需先解决Control捕获独占与共享清理点，集中优化。

### 10.3 完成、清理与接线

每条远端命令通过HDC独立argv `[-t,serial,shell,固定脚本]`，脚本将该命令stderr合并到stdout，前台等待完成后打印唯一 `DF_INPUT_DONE:token:stage:status` 终端帧。阶段分别为version/help/action/enter。帧必须完整、唯一、位于末尾且标识匹配，状态为0至255标准十进制；普通动作同时要求精确 `No Error`，版本及帮助各自核对档案，客户端stderr不得含非空诊断。不返回任意工具输出或原文本。

在真实HDC客户端和完整远端帧均确认后，非零退出或失败诊断是业务失败但资源可确认。缺失或伪造帧、取消、超时或Future丢弃不能用客户端退出推断远端结束，立即固定既有清理点并保持粘性unresolved；不全局杀设备输入服务、不重试和回滚。每笔资格/输入/回车均复用原调用期限，后续事件前检查取消；取消胜出后不再补发回车。两秒清理预算不重授。

返回 `{device_id,action:<kind>,dispatched:true}`，无产物。主代理接线为 `mod input`、`operations::Input::DeviceInput(input::Input)`、严格解析分支与execute分支；session禁止输入产物。之后双清单追加一贡献一能力、发现追加基于资格的input availability、别名采用 `device_envelope` 与 `value/wrapped:true`。原共享写锁、provider屏障、代际和Job历史自然复用，不扩展服务器平台分支。

库回归先覆盖纯模式、所有边界、独立argv和文本字面量、版本/帮助、成功 `No Error`、非零与诊断、伪帧和丢弃粘性；主代理后续集成并跑定点检查。独立协议、同设备互斥、服务/分发、真实HDC及真机输入效果分别验收。本节没有执行Cargo、服务或真机测试。

## 11. 本批集成证据与剩余边界

主代理已接入lib、operations及发现资格观察，双清单和格式2绑定为十二贡献、十一能力、十二别名，其他平台和公共DTO未改变。新增输入库16/16及Harmony集成库79/79通过，debug插件构建退出0；架构24模块、双清单字节一致与数量核对通过。公开宿主validator接受十二贡献，原件 `artifacts/harmony-input-contract-QWsnaR/report.json`；库原件 `artifacts/harmony-input-integrated-{lib,all-lib}-20261012.txt`。

当前Control要求单路独占捕获，本批不扩大公共接缝。发现最多128设备，资格启动窗口八秒；窗口届满不再启动下一探测，已启动工具继续消耗原调用截止点和同一清理点。未完成探测明确input不可用、保留其他八能力，不能宣称所有设备已探测或全量并发达标。

新增独立协议、实际宿主输入、旧发现夹具适配、完整workspace/Clippy、正式分发及真实HDC/真机效果仍在验收队列。此前截图36协议与冻结debug服务属于十一贡献版本，不转计本批；后端已继续独立终端插件，研发不等待本批分发。

## 12. 客户端非零退出的集中修复

2026年10月12日独立协议19/20与debug服务定位同一缺陷：HDC客户端实际OS退出7，stdout已包含完整匹配的`DF_INPUT_DONE:token:action:0`终端帧，插件却返回`cleanup:failed`，导致宿主保持draining。原件为`artifacts/harmony-input-client-nonzero-defect-20261012.json`及`artifacts/harmony-input-service-debug-summary-20261012.json`，保留首失败，不将此前六轮通过扩写为整批通过。

根因是公共普通捕获在非零退出时只返回有限错误与stderr，stdout终端帧未交给输入层；`RemoteWaiting`因提前退出保持未确认。仅输入私有执行改用现有公开工具流，完整收集有界双流并等待真实直接进程退出，保留OS退出状态。严格回执解析先确认该关联远端命令已终结，再分别报告客户端非零、stderr诊断或远端非零业务失败。非零客户端仍返回原有限依赖错误；普通成功文本、stderr及客户端退出均不能代替完整匹配帧。

私有写集为`src/input/execution.rs`、`src/input/execution/capture.rs`、所属中文README、`src/input/tests/execution.rs`与本文。通用Control、公共捕获契约、独立协议oracle及服务驱动未改。沿原绝对截止点、每流1MiB、受限环境和共享租约；取消、到期、超限、管道失败、Future丢弃或缺失/错误/重复帧继续保持未确认，同一二秒清理点不重新授予。

新增四项库回归用真实Node直接进程检查OS退出7及原双流：完整帧的客户端非零业务失败、五种不合格帧、远端非零及客户端stderr。回归代码尚未执行；格式、Cargo、Clippy、debug构建由主代理统一定点运行，测试角色独立重跑已知缺陷与协议。研发交接后继续下一独立业务，不等待整批服务与分发。

五文件严格UTF-8与所属`git diff --check`已实际通过。当前仅冻结源码与新增回归，不记为修复后独立协议、服务或真机通过。

## 13. 主代理修后集成与独立known结果

修后专项7/7、完整库83/83及串行独立输入协议20/20通过。原并行输入协议19/20在既有期限墙钟断言失败，该期限单独1/1和正确串行全20均通过；没有修改期限oracle或生产预算，首失败保留。原件分别为`artifacts/harmony-input-client-exit-fixed-lib-20261012.txt`、`artifacts/harmony-input-client-exit-fixed-protocol-20261012.txt`和`artifacts/harmony-input-client-exit-fixed-serial-protocol-20261012.txt`。

主代理修复本批Clippy告警，内部枚举名称为DeviceAction，并按现有风格合并条件/替换无变量format；公开ID、输入与期限未变。最终全目标Clippy及debug宿主/Harmony/两Android插件构建退出0，原件为`artifacts/harmony-input-client-exit-final-clippy-20261012.txt`与`artifacts/harmony-input-client-exit-final-debug-build-20261012.txt`。最初Clippy失败仍保留。

新版known真实debug报告`artifacts/harmony-input-service-debug-8de3fb23-5627-4bcf-941f-f8f9c336231f/report.json`通过1轮/2Job/8工具。匹配唯一完整回执后客户端OS7映射原dependency_failed且cleanup complete；loaded无cleanup_failed，父子OS句柄终态与正常卸载成立。9输入冻结清单为`artifacts/harmony-input-client-exit-frozen-debug-d2cf5e6d-fd75-4128-b587-060bc42ef516/identity.json`。

修前六轮49Job/151工具和旧known失败各保留原版本，不转计新版。当前完整阶段门禁另行集中执行，完整修后all、release/正式包/npx、真实HDC、真机输入效果和跨平台仍待；研发继续SDK独立业务，不等分发队列。
