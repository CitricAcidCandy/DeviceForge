# Harmony 连接与断开插件实施裁定

日期：2026-10-12。模式为 architecture-first，验证采用 Hybrid。本批方案已由交付主代理裁定，当前仅形成下一批实施依据，生产代码、双清单和现有正式包保持冻结；本文不表示连接实现、服务、分发或真机已经通过。

## 目标、旧行为与工具事实

独立 `harmony-device` 插件新增 `connect@1`、`disconnect@1`，设备 API 3、`scope=provider`、`access=write`、总预算均为 30000 毫秒。完成后为十贡献、九能力，其中七项设备能力、两项提供者能力；发现结果仍仅声明七项设备能力，不把连接管理放入每台设备的 availability。

旧 Electron 工程 `src/renderer/ApkTool/src/consts/HdcCommand.ts` 声明 `tconn {host}` 与 `tconn {host} -remove`。`script/deviceDebug/hdc/device.ts:38`、`:47` 接收 `deviceId` 和 `port`，将占位符替换为带额外字面 `}` 的字符串，再经 `base.ts:13` 恒定添加 `-t` 并执行 shell 字符串；没有明确成功响应判定。当前宿主没有既有 `harmony.connect`、`harmony.disconnect` 注册，因此不把新增能力或平铺别名描述为已验证的旧宿主兼容。

本批修正为提供者范围的连接管理，业务参数独立传入 argv，不保留旧错误拼接，也不从已有设备标识猜测地址。旧 `setRemote`、`tmode` 和全局 `start`、`kill`、重启操作不进入本批。

官方 OpenHarmony `developtools_hdc` 的 `OpenHarmony-5.0-Release` 分支取证固定于提交 `4ce65f76fc57e64318b730c52eae6893f580f38d`：

| 证据 | 工具行为与本批结论 |
| --- | --- |
| [translate.cpp:189](https://github.com/openharmony/developtools_hdc/blob/4ce65f76fc57e64318b730c52eae6893f580f38d/src/host/translate.cpp#L189) | ` -remove` 后缀切换为断开；不是 `-r`。TCP 校验使用 `uv_ip4_addr`，仅额外将 `localhost` 转换为 `127.0.0.1`；本批支持 IPv4 或字面 `localhost`，不支持其他 DNS 名称或 IPv6。 |
| [host_tcp.cpp](https://github.com/openharmony/developtools_hdc/blob/4ce65f76fc57e64318b730c52eae6893f580f38d/src/host/host_tcp.cpp) | 设备 TCP 连接仍走 IPv4 地址结构；不能因为宿主服务监听支持 IPv6，就把设备连接声明为 IPv6。 |
| [server_for_client.cpp:309](https://github.com/openharmony/developtools_hdc/blob/4ce65f76fc57e64318b730c52eae6893f580f38d/src/host/server_for_client.cpp#L309) | 新连接成功为 `Connect OK`；重复连接为 `[Info]Target is connected, repeat operation`；创建或连接失败返回明确失败诊断。 |
| [server_for_client.cpp:344](https://github.com/openharmony/developtools_hdc/blob/4ce65f76fc57e64318b730c52eae6893f580f38d/src/host/server_for_client.cpp#L344) | 断开成功不输出确认行；找不到目标返回 `[Fail]No target available`，不能静默转为幂等成功。 |
| [main.cpp:193](https://github.com/openharmony/developtools_hdc/blob/4ce65f76fc57e64318b730c52eae6893f580f38d/src/host/main.cpp#L193) | 普通客户端命令可能自动拉起共享 HDC server；进程退出码不足以证明命令业务成功，更不证明 daemon 状态。 |

本地工具为 `E:\OpenHarmonyHdc\12\toolchains\hdc.exe`，SDK 包元数据为 API 12、`5.0.0.71`。本次只读运行 `-v`、`-h`、`-h verbose`，均退出 0；版本输出 `Ver: 3.1.0b`，详细帮助明确 `tconn key` 与 TCP `ip:port`。上述帮助和版本在选项分支退出，不执行连接或服务操作。本地二进制尚未进行连接、重复连接、断开或未知目标实测；公开源码与 SDK 包版本分别记录，不宣称它们具有相同字节或全部运行行为。

## 输入、固定命令与结果

封套严格为 `{device_id:null,input:{address}}`。`device_id`、`input`、`address` 均必须显式提供，拒绝未知字段、缺失、错误类型和字符串设备标识。业务输入只含 `address`，不接受端口分字段、`deviceId`、额外 argv、命令字符串或工具路径。

地址仅支持规范点分 IPv4 和字面小写 `localhost`，均要求显式 `:port`。IPv4 四段各为 0–255，拒绝省略段、八进制或十六进制形状、IPv4 前导零、其他 DNS、IPv6、裸 IP、空白、控制字符和选项形状。端口仅接受 1–5 个 ASCII 十进制数字，数值为 1–65535；地址最多 21 字节。`localhost:port` 保留请求字面值交给 HDC，不在插件内解析 DNS 或改写为 `127.0.0.1`。目录中的真实目标键只由显式发现取得。

| 能力 | 固定独立 argv | 成功业务结果 |
| --- | --- | --- |
| `connect@1` | `[tconn,address]` | `{output}`，保留裁剪前后空白后的 HDC 成功文本 |
| `disconnect@1` | `[tconn,address,-remove]` | 静默完成时 `{output:""}` |

两个命令均不带 `-t`，不调用 `tmode`、`discover`、`list targets`、`start`、`kill`，不重试、不自动回滚。每个 Job 只执行一条连接管理命令。

两流沿既有 `Control::capture` 各限 1 MiB，要求零退出和有效 UTF-8。首先复用失败诊断规则，包括大小写无关的精确 `[Fail]`；任何失败诊断优先于成功行或静默，固定错误不公开工具路径或原始诊断。非零退出、乱码、超限、取消和超时全部失败。

连接只接受裁剪后的完整行精确等于 `Connect OK` 或 `[Info]Target is connected, repeat operation`，不借用 ADB 的成功行，也不把空输出或泛化 `Success` 当作成功。断开接受零退出、两流裁剪后均为空且无失败诊断的静默完成；未知非空响应不自动扩大为成功形态。静默完成只能证明本次客户端命令结束，不确认后台连接已经物理断开。

宿主继续沿协议 4 包装为 `{result,artifacts:[]}`。新增示例平铺别名 `harmony.connect`、`harmony.disconnect` 只接受 `{address}`，使用格式 2 的 `device_capability`、`device_envelope`、`value` 与 `wrapped:true`，由宿主生成显式 null 封套；别名和公开设备入口必须共享同次任务、代际、锁、期限及清理，不另提交嵌套 Job。

成功业务结果的具体 JSON 为 `{"output":"Connect OK"}`、`{"output":"[Info]Target is connected, repeat operation"}` 或断开的 `{"output":""}`。不新增 `connected`、`disconnected`、`online`、设备引用、目录快照或产物字段，不把未知响应映射为布尔成功。协议 4 的结果为例如 `{"result":{"output":""},"artifacts":[]}`；旧绑定消费后仍只取得业务对象。

## 宿主准入、锁与前端消费

`application/src/devices/rules.rs:81` 要求固定封套显式包含两个字段；提供者能力要求 null。`:129` 仅在 `device_id` 有值时查询发现目录和在线 availability。因此连接、重复连接以及断开都可针对尚未发现的地址提交，仍必须持有当前提供者 generation，不能沿设备范围提交来绕过准入。

`application/src/devices/locks.rs:59`、`:93` 的提供者写屏障使同一提供者的连接管理相互串行，并与所有所属 `device` 范围读写动作冲突；锁以提供者 ID 为键跨代共享。既有设备读与同设备写本身允许并行，本批不改变该语义。屏障不表示对其他独立 HDC 客户端的全局互斥；发现刷新继续使用宿主独立发现通道，本批不修改该机制。

前端 SDK 已支持 `scope=provider`、`access=write`、`deviceId:null` 和普通对象输入，生产代码与生成类型无需为本批新增字段。先取得当前提供者元数据及 generation，即可提交 `{address}`，不要求已有设备目录、在线状态、selection 或设备 availability。提供者动作不绑定当前设备选择；caller 与插件范围的取消、代际及结果交付资格继续沿现有框架。

连接或断开完成后，前端显式调用 `refreshProvider`，再从本次真实观测取得 `DeviceRef`。能力 Job 不自动刷新、合成在线设备、删除旧目录条目或改变选择；没有刷新时原目录可能仍保留旧状态，不能把它作为该次连接成功或断开成功的证据。`localhost` 对应的真实目标键由 HDC 与后续发现决定。

## 期限与资源所有权

两个能力均继承协议 4 InvocationContext 的原绝对截止点。排队、提供者写屏障、配置、工具启动、捕获、响应解析与发布共用 30000 毫秒预算；执行和发布前后继续检查取消及期限。不接收请求自定义期限，不因工具内部重试重新计时，不套用 Android 的 5000 毫秒工具阶段，也不新增第二套执行器。

工具调用只复用现有 `Control::capture` 的受限环境、每流上限、进程租约和首次固定清理点。`session::validate_context` 继续拒绝非安装动作的输入产物；本批不创建私有安装目录、副本、输出文件或产物。取消、超时、Future 丢弃与卸载只处理本次 HDC 客户端及插件进程，清理窗口沿既有两秒上限；未确认清理保持粘性失败和宿主 draining/cleanup_failed。

共享 HDC server、设备 daemon 和连接状态属于部署者管理的持续外部状态。HDC 自行拉起的共享 server 也不归本次任务清理所有权；插件不发送 `kill`、`start -r`、反向 `tconn -remove` 或 `tmode` 来补偿取消。已建立连接可能在客户端被取消后继续存在，客户端退出不证明持续连接、派生进程或设备事务已回滚。常驻会话、连接租赁和真机长期稳定性另批实施，不因这两项离散调用通过而计入完成。

## 文件职责与独占写集

当前只新增本文。下列生产与库测试写集须等主代理解除冻结后开放；后端开发独占，前端与测试助理不同时接手这些文件。新增模块的 README 使用中文与 UTF-8。

| 单元 | 输入、输出及职责 | 副作用与边界 |
| --- | --- | --- |
| `plugins/harmony-device/src/network.rs` | `connect`、`disconnect` 的业务输入与执行委派；固定 argv、结果对象、原期限检查 | 只调用既有 `Control`，不执行发现、管理 daemon 或接触宿主内部模块 |
| `src/network/models.rs`、`rules.rs`、`tests.rs`、`README.md` | 严格 `{address}`、地址资格、响应判定和纯规则测试 | 无进程、配置、宿主目录或任务副作用 |
| `src/operations.rs`、`operations/models.rs`、`lib.rs` | 两个新短贡献及 `Input::Network` 委派；提供者封套先验证显式 null | 保留既有 `Envelope.device_id:String` 和全部设备动作资格，新增独立提供者封套，不重写详情或安装流程 |
| `manifest.json`、`manifest.example.json` | 同步十贡献、九能力、两个提供者写能力、严格 null/input/address schema 与 30000 毫秒 | 七项设备能力和发现 availability 保持其现有业务含义 |
| `aliases.example.json`、插件根 `README.md` | 两项新增平铺绑定、地址范围、结果及资源边界 | 不新增内置工具回退或宿主平台分支 |

测试助理另独占 `tests/cases/network.rs`、`tests/protocol.rs` 和必要的 `tests/support` 狭窄夹具，以及连接服务驱动与原件审核；以独立原帧和假 HDC 进程覆盖固定命令、响应、输入、期限及清理，不调用生产解析器证明自身，不改无关测试语义。后端开发不同时接手这些独立协议或服务测试文件。

前端开发只更新所属端 Harmony 消费合同；主代理负责共享构建、服务、分发、生成器与根 todo/交接记录。公开 SDK、HTTP DTO、宿主锁和生成类型预计无需修改；出现新跨层需求先回流裁定。

## 最小验收与当前证据边界

纯规则覆盖规范 IPv4、`localhost`、端口两端边界、超限、注入形状、缺失和未知字段、显式 null 与所有原设备封套回归。响应覆盖新连接、重复连接、静默断开、未知目标、成功后两流失败优先、未知响应、非零退出、乱码和限额。

独立协议证明一次 Job 只有固定的一条 argv，`localhost` 字面值保留，没有 `-t`、自动发现、daemon 或回滚命令；验证预取消/原期限已过不启动、运行取消/超时的本次进程退出、共享清理确认、无输入或输出产物，以及所有原 Harmony 能力回归。

主代理串行执行受影响的库/协议和完整门禁；测试助理驱动 HTTP/MCP 与新增平铺绑定，证明无发现目录也可提交提供者能力、device 范围错误被拒绝、同提供者写屏障冲突、旧代/卸载取消、日志与 SQLite 任务终态。发现前后目录分别取证，不用旧观测替代本次结果。随后验证调试/发布服务、双清单、正式包和真实 npx 安装分发。

当前已有旧源码、宿主准入/锁、公开源码及本地帮助/版本取证；本批生产实现、自动化测试、服务、分发与真实设备均未执行。假 HDC 只证明契约和本次进程行为，不替代实际连接、设备调试模式、共享 server 状态、派生树或性能验收。
