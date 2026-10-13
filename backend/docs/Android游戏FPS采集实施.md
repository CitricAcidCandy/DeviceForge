# Android 游戏 FPS 采集实施

日期：2026年10月13日。采集功能按用户要求继续开发，性能专项待全部业务完成后再安排。本批实现游戏实际展示帧窗口，不依赖 SAS 二进制；CPU/PSS/RSS 原始字段和现有 FrameWindow 合同保持。来源固定提交、官方接口及五指标边界见 [来源证据](Android游戏采集来源证据.md)，公共架构裁定见 [实施方案](Android游戏指标Rust采集实施.md)。电气、温度和可选调用栈本批未接。

## 职责与调用

`rules/performance/fps.rs` 负责包名边界、唯一游戏层、实际展示时间戳、去重与窗口；没有 I/O 或时钟。`session/performance/fps.rs` 负责沿现有工具控制器读取两个有界快照并交既有单槽 worker 解析；不会新增阶段预算、采集进程框架或宿主平台分支。

基础性能流程在 meminfo 完成后读取可选游戏帧，再执行原最终 /proc/pid/stat 身份复核和 /proc/stat。因此 FPS 读取期间进程 starttime 变化会拒绝整次采样，不能返回跨进程的部分成功。原始 CPU 和内存资格、严格输入、零产物与私有目录、不依赖 Java/bundletool 保持。

可选流程为：`dumpsys SurfaceFlinger --list` →唯一层的第一 `--latency` →原绝对期限内 80 ms 观察间隔→再次 `--list` 确认同层→第二 `--latency`。观察间隔只给两个快照留时间，不用 80 ms 或固定刷新率推算帧数。无层路径为基础五笔加一笔列表，共六笔；有效层路径为基础五笔加四笔读取，共九笔。中途未知格式或层变化可提前缺测。没有 `--latency-clear` 或共享计数重置。

ADB 继续使用固定部署入口、`-s serial shell -T`、Restricted 环境、两流各 1 MiB 与真实直接客户端退出确认。层名最多 1024 UTF-8 字节，拒绝控制符和 lossy 替换符，并按单一 shell 数据参数转义；不把层名当任意命令。纯列表最多 4096 行、帧记录最多 256 行，超限明确失败。

## 窗口口径

层名必须包含精确包名边界及 SurfaceView/BLAST 标识，并且只有一个候选。多个候选、仅相近包名、未知层或二次列表变化时省略。源标识为 `sf_present_` 加层名 SHA-256 的前十六个十六进制字符；不同层不沿旧窗口继续，来源长度满足既有公开约束。

延迟文本要求合法刷新周期头和严格三列整数，使用第二列 actualPresentTime。0 与 INT64_MAX 不计为有效展示；连续重复实际展示时间只算一次，回退或未知格式缺测。纳秒以整数解析，不转浮点，保留接近 INT64_MAX 时的精度。

第二个快照必须包含第一个快照的最后展示锚，frames 只数锚后的新且不同的展示时间，duration 来自最后新展示减锚。无历史、无新展示或丢锚省略，不填 0；跨度最多 60 秒。公共合同只有整数毫秒，向上取整避免缩短跨度而夸大 FPS，继续核 frames≤duration_ms；宿主按既有窗口算 FPS。该口径为所选游戏层的展示频率，不宣称等同引擎提交、GPU 完成或应用全部 UI 的帧数。

固定调试接口的依赖失败允许缺测，基础 CPU/内存仍须合法。取消、原期限到期、输出/结构超限和未确认清理必须失败，不能被可选采集吞掉；成功结果交付前再次核上下文。

## 实际验证与剩余边界

本轮通过已存在的 Visual Studio 2022 x64 初始化入口串行运行：

| 命令 | 实际结果 | 报告 |
| --- | --- | --- |
| cargo fmt -p deviceforge-android-device-plugin | 退出 0 | runner 同次执行链 |
| cargo test --locked -p deviceforge-android-device-plugin --lib | 89/89，退出 0，含新增 9 项纯 FPS 回归 | artifacts/android-fps-d6290c07-8441-4e37-b812-953b0b3e4760-library.txt |
| cargo test --locked -p deviceforge-android-device-plugin --test protocol | 133/133，退出 0，含新增 7 项 FPS 原帧/真实进程回归 | artifacts/android-fps-d6290c07-8441-4e37-b812-953b0b3e4760-protocol.txt |
| cargo clippy --locked -p deviceforge-android-device-plugin --all-targets -- -D warnings | 退出 0 | artifacts/android-fps-d6290c07-8441-4e37-b812-953b0b3e4760-clippy.txt |

同次 runner 报告为 `artifacts/android-fps-d6290c07-8441-4e37-b812-953b0b3e4760-runner.txt`，隐藏 cmd 进程已终态退出 0 并回收，共享 Cargo 已交回主代理。实际协议回归验证九笔固定 argv、两个同层快照、不清空全局状态、真实新帧/去重、无层/歧义/层变化/丢锚/未知文本缺测、依赖失败缺测、两流输出超限、四个可选工具阶段取消、原截止点、FPS 期间进程换代和纳秒整数精度。每笔工具均使用真实 PID 等待确认，夹具不引用生产解析器生成期望。

双清单逐字节同步，fps=true 表示支持有资格的可选展示窗口；并非每次采样都返回 FPS。新 FrameWindow 来自插件真实输出，HTTP/MCP、宿主历史/调度、浏览器消费、热卸载、Release 和分发由主代理分别集成，不借包级回归宣称服务通过。

本轮证据是 Rust 库及独立假 ADB 真实进程协议验证，没有真实 Android 设备或系统 SurfaceFlinger 的数据证据。OEM 层格式、SurfaceView/BLAST 层选择、游戏前后台/多窗口/多层、设备刷新率、真实 PID/计数精度、默认共享 ADB server 和派生树继续独立验收。功耗、温度、原生/ART/引擎托管调用栈未由本批实现；性能专项仍延后。

静态复核未发现当前阻断。层归属目前依据层名的精确包名边界和唯一候选，尚未核 SurfaceFlinger ownerPid/UID；Android shell/OEM latency 格式和真机帧准确性继续待验。80毫秒观察等待已有取消/到期 select，但没有单独覆盖该等待段的协议用例；本批取消用例覆盖四个真实在途可选工具阶段，不借这些证据宣称等待段单独通过。该缺口不作为继续普通业务的阻断，也不增加抢时间的墙钟测试。

本批源码及进程工作已停止，不再新增采集代码或启动验证进程；电气/温度私有草案保持当前状态，后续按主代理新合同继续。

## 2026-10-13 归属补齐实施裁定

模式architecture-first；范式Hybrid：先核AOSP二进制字段及归属资格，纯解析/原帧/独立服务并行。独立FrameWindow公开字段保持；归属不明省略，不回退仅名字。

| 单元 | 职责与输入输出/副作用 | 边界 |
| --- | --- | --- |
| rules/performance/fps及owner子模块（后端） | 有界protobuf、UID、候选身份链与帧窗口纯规则 | 不访问设备、不猜inputInfo PID |
| session/performance/fps.rs和performance.rs（后端） | 固定命令取得身份及快照，前后复核、原期限/取消；ADB I/O | 不改变宿主DTO、不清空统计 |
| performance前端（前端） | 缺测/窗口原值/历史与来源消费，FPS上限校验 | 不绘制产品页面、不自造测量 |
| 独立FPS服务驱动（测试） | 官方字段的手写二进制与native假ADB、HTTP/MCP/实际前端/卸载 | 不把假设备当真机 |
| 主代理 | 官方contract裁定、集成命令与生成/交付记录 | 不重叠后端写集 |

选择SurfaceFlinger proto身份见证，比较文本名字回退：名字可被重复或改名，不能证明进程归属，故不作为有效FPS资格。候选自身owner_uid必须等于目标/proc/pid/status四个一致UID；从候选沿真实parent有界查找metadata key1 UID及key6 PID，至少一处同层同时证明目标UID/PID，整链任何已声明相关值冲突即拒绝，重复ID/环/多候选或见证不唯一拒绝。祖先creator owner_uid允许system，但所有见证meta必须一致；source摘要保存候选id/name和整祖先链身份、目标pid/uid，不用层名独自定位。

固定读取dumpsys --proto SurfaceFlinger与/proc/pid/status。支持已核AOSP裸LayersProto及带固定magic/单entry的TraceFile，未知/多snapshot/重复关键字段、非法wire类型不猜测；metadata field42、owner_uid field53、metadata map key1/key6值为四字节小端int32，必须记录官方schema来源。解析1MiB原两流、4096层、最多64meta/层、层名1024字节、迭代取消/原期限。录制前后同候选和完整身份链；最终原stat/startticks复核及UID复核。UID初读不可用可缺FPS；已确认后变化拒绝整次采样。

前台不是本批新增推断：不根据包名前台/层加载顺序挑候选，不虚构前后台证明；同归属多个游戏buffer层继续缺测，所有普通CPU/内存/温度等仍须合格。必要证据为合法/缺失/冲突/坏proto/恶意长度、环/层替换/UID与starttime变化、原期限/在途取消、实际HTTP-MCP/前端/卸载历史。root堆栈和画面关联已获用户授权，另定义录制任务与时间基准，不能塞入十秒基础采样。

## 2026-10-13 PID/UID归属实现增量

本段取代上文仅按层名定位的当前行为说明，原验证记录保留为旧版本证据。本批尚未运行编译、测试或服务验证，不能转计原89/133项结果。

新增纯规则 owner 模块及有限 protobuf 读取：只接受首字段为 field1 长度消息的裸 LayersProto，或首字段 fixed64 魔数为 LYRTRACE 的 LayersTraceFileProto。后者只能有一个 entry，快照只能有一份 layers；禁止猜测包裹格式、重复关键字段、未知线格式和超出缓冲的长度。两流工具捕获继续各1MiB；原二进制只从stdout解码，stderr非空降为缺测，取消、到期及超限仍失败。结构上限4096层、64份元数据/层、1024字节层名和65536个读取字段；每个字段、每个祖先继续检查原期限与取消。

候选仍以精确包名边界和 SurfaceView/BLAST 名称作为过滤条件，但必须同时满足自身 owner_uid 与目标进程四个相同UID一致。沿实际 parent 找到同一层的 metadata key1=UID、key6=PID见证，至少一处完整见证且所有已声明归属值无冲突；祖先 creator UID允许系统UID，不能代替元数据中的应用身份。重复ID、父链缺失/环、目录同名或多个合格候选均缺测。摘要加入PID、UID及整父链的id、parent、name、creator UID和归属元数据；父链任何变化都会撤销当前窗口。多处一致见证可以共存，无法以最近祖先绕过远祖冲突。

合法命令链为：pidof、初stat、meminfo、初status、初proto、初latency、80ms观察、末latency、末proto、三条环境探针、末stat、末status、系统stat，共14条ADB命令。身份proto读取固定为 -s serial shell -T dumpsys --proto SurfaceFlinger；进程UID固定为 -s serial shell -T cat /proc/PID/status。latency沿既有固定命令和单一数据参数转义，无--list或--latency-clear。初UID不可读时缺FPS，总9条命令；初UID可读但首proto无资格时总11条。后置proto在第二latency之后比较完整身份，末stat保留starttime核验；初UID已确认后，末UID变动或不能确认会拒绝整次采样。

官方字段和实际导出路径均本轮只读核验：

- [Android12 layers.proto](https://android.googlesource.com/platform/frameworks/native/+/refs/tags/android-12.0.0_r1/services/surfaceflinger/layerproto/layers.proto)：LayersProto.layers=1；LayerProto.id=1、name=2、parent=25、metadata=42、owner_uid=53，没有owner_pid字段。
- [新SurfaceFlinger proto](https://android.googlesource.com/platform/external/perfetto/+/refs/heads/main/protos/perfetto/trace/android/surfaceflinger_layers.proto)：TraceFile.magic_number=1、entry=2；Snapshot.layers=3。魔数固定64位小端值0x454341525452594c，整个字段以09 4c 59 52 54 52 41 43 45起始。metadata的新string类型按原始四字节处理，不做UTF-8替换。
- [图层元数据定义](https://android.googlesource.com/platform/frameworks/native/+/refs/heads/main/libs/gui/include/gui/LayerMetadata.h)和[实际读写](https://android.googlesource.com/platform/frameworks/native/+/refs/heads/main/libs/gui/LayerMetadata.cpp)：key1为OWNER_UID，key6为OWNER_PID；int32通过四字节memcpy保存，本批限定已核Android小端数据。
- [窗口管理器赋值](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/services/core/java/com/android/server/wm/WindowStateAnimator.java)：构造窗口时将session UID/PID写入上述metadata；[LayerProtoHelper导出](https://android.googlesource.com/platform/frameworks/native/+/refs/heads/main/services/surfaceflinger/LayerProtoHelper.cpp)在TRACE_EXTRA写入metadata，owner_uid独立导出。
- [dumpsys参数](https://android.googlesource.com/platform/frameworks/native/+/refs/heads/main/cmds/dumpsys/dumpsys.cpp)与[SurfaceFlinger导出](https://android.googlesource.com/platform/frameworks/native/+/refs/heads/main/services/surfaceflinger/SurfaceFlinger.cpp)：--proto显式传给服务；AOSP12为裸图层，当前主线导出带魔数的一次快照。shell在AOSP可执行DUMP，不代表所有OEM ROM都会保留该接口或元数据。

实际ROM、元数据继承和游戏多窗口兼容仍待真实设备验证。缺少可信见证只能缺测，不能重回层名归属。当前尚未完成共享门禁、独立HTTP/MCP及前端服务证据；本批不包含root堆栈实现，也不作为性能专项测试。

## Android 11 图层字段兼容

Android 11图层不保证提供owner_uid字段53。此字段缺失时仍必须由真实同层metadata键1的UID与键6的PID成对匹配目标/proc身份，祖先链中任何PID/UID声明冲突均拒绝，不能跨层拼见证。若候选存在owner_uid声明，该声明仍须等于目标UID。层名仅用于选择SurfaceView/BLAST和对应latency条目，不作为归属证明。无有效同层见证时FPS保持缺失；旧版纯夹具不能替代真实手机metadata验收。
