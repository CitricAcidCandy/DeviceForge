# 安卓 APKS 安装插件实施裁定

日期：2026-10-10。模式：architecture-first。状态：十一贡献冻结版已撤宿主装配与安装侧车，62 库、108 独立协议、959 workspace 测试、构建及必要静态门禁通过。两模式 runtime 最终复跑退出0；独立 debug 服务 54 checks/60 Jobs/57 工具通过。首轮路径表示断言、runtime 清理失败、服务夹具顺序失败均保留，窄修未放宽生产规则或预算。release、当前正式分发及真机仍待；本版本结果不转计正在开发的性能十二贡献版本。

门禁见根 `artifacts/android-apks-integration-gates-20261010.txt`；runtime 复跑见 `android-apks-performance-runtime-rerun-20261010.txt` 与 `android-apks-runtime-after-retention-20261010.txt`。独立服务原件见 `artifacts/android-device-smoke-debug-37b535e7-d430-4c57-8c4f-e20731cbec44/report.json`：51 成功、4 预期失败、5 取消，14 Java 与 43 ADB；175 保留原件及 35 输入身份核对稳定，22 私有安装副本清理、正常 exit0 与端口释放成立。此处路径均相对工程根目录。

## 目标与选定路径

将宿主生产装配的 `android.app.install_apks` 迁入现有独立 `android-device` 插件，使用协议 4、设备 API 3 和已有公开公共库。保留设备匹配安装的固定参数、APKS 外层校验与旧结果对象；复用该插件私有副本、受限文件工作、工具租约和清理流程。

选定单一路径：为同一提供者新增 `app.install_apks@1`，经现有设备准入与任务执行。包解析规则仍属于 `android-package-core`，设备匹配和实际安装由部署者配置的 bundletool 完成。影响范围为插件配置/贡献/规则/资源编排、宿主装配撤除、静态绑定和测试部署；HTTP/MCP 路由、领域合同、公共 SDK、公共工具库与前端生成类型不扩写。

不增加任意 bundletool 参数、设备规格、高级匹配、签名配置、公共 SDK、全局设备锁或新清理框架。APKS 提取继续由 `android-packages` 提供；`installed:true` 仅表示安装工具调用完成，不表示应用已启动或业务可用。

## 公开贡献、输入与结果

| 项目 | 冻结合同 |
| --- | --- |
| 短贡献 / 能力 | `app.install_apks` / `app.install_apks@1` |
| 完整贡献 ID | `plugin.android-device.app.install_apks` |
| 范围 / 访问 | `device` / `write` |
| 总预算 | 120000 毫秒；仅在能力声明，不另加普通 execution 预算 |
| 严格输入 | `{device_id,input:{artifact_id}}`，封套两字段必须显式存在；每层拒绝未知字段 |
| 设备 ID | 复用现插件 serial 资格并保留原文；旧 alias 继续使用原 ASCII 标识 schema |
| 输入授权 | 恰好一行 `/input/artifact_id`，授权 ID 与业务 ID 完全一致；36 字符标准连字符 UUID |
| 文件资格 | 合法单文件显示名，以 `.apks` 结尾，大小写不敏感；最大 64 MiB；size 与完整 SHA-256 匹配 |
| 插件 value | `{artifact_id,device_id,installed:true}`，不返回工具诊断或新产物 |

复用清单已有 `artifacts.input_pointers=["/input/artifact_id"]`；截图保留原 outputs 声明，APKS 本身不要求输出授权、不发布文件实体。两个清单逐字节一致。插件只接受短贡献名，完整 ID、缺字段、错误封套与非法元数据在配置和副作用前拒绝。

插件新增后为十一项贡献、十项能力；发现不算能力。在线设备的 device 能力由七项增为八项，包含 `app.install_apks@1`；沿用原在线状态规则。所需 Java/JAR 未配置时执行返回固定依赖失败，不新增配置健康度或背景探测机制。

## 配置与固定工具调用

旁置文件、`--config <绝对路径>`、格式 1、65536 字节上限、未知字段拒绝和 `scratch_root` 保持原配置合同。增加可选 `tools.java` 与 `tools.bundletool`，复用现 `android-packages` 的 JAR 形状：

```json
{"format_version":1,"tools":{"adb":"adb","java":"java","bundletool":{"kind":"java_jar","jar":"G:/tools/bundletool.jar"}}}
```

Java/ADB 入口只接受合法绝对路径或单一程序名；bundletool 只接受 `java_jar` 和普通绝对 JAR 路径。普通设备动作不要求新增工具字段，APKS 调用才要求 ADB、Java 和 JAR 全部配置。业务请求不能覆盖工具、目录、环境或参数。

bundletool 接收绝对 ADB 文件路径。若 `tools.adb` 为单程序名，按 PATH 搜索现有普通文件；Windows 保留无扩展名时尝试 `.exe` 的原行为。路径解析和资格检查沿原上下文受控，不在异步调度线程执行阻塞文件核验；沿用插件祖先目录无链接/重解析点规则。

Java 的 argv 顺序固定为：

```text
-Xmx256m -jar <部署JAR> install-apks --apks=<私有input.apks> --device-id=<serial> --adb=<绝对ADB文件>
```

每项独立 argv，不经过 shell。Java 使用同一调用的直接进程租约和原 `D_L`；cwd 及 TEMP/TMP/TMPDIR 均设为本次私有目录，受限环境仅保留现工具库六项变量。stdout、stderr 各最多 1 MiB，维持旧安装限额；普通 ADB 调用参数及环境不变。

## 既有成功语义与包规则

旧 APKS 安装不要求独立 `Success` 行。保留以下资格：直接工具零退出，stdout/stderr 按 `String::from_utf8_lossy` 合并，转 ASCII 小写后不含下列任一子串，便返回 `installed:true`：

```text
failure, failed, error, unable, cannot, offline, unauthorized, no devices, incompatible
```

空输出合法；任一路失败文本优先于成功文本。非零退出、超限、取消、到期或清理失败必须失败。不得复用 APK 的 `rules::artifacts::install_output`，不得在本批增加必须有成功行或严格 UTF-8 的新规则。失败信息为固定中文，不回传工具路径、任意诊断或业务输入。

授权源经现普通文件与打开句柄资格核验，按声明大小和完整 SHA-256 流式复制为私有 `input.apks`；Java 只读该副本。既有 APK 调用仍生成 `input.apk`，目标名称由插件内部固定选择，不由请求传入。

在现 `Session::work` 中打开私有副本的 `ArchiveProfile::Structure` 归档，并调用公共 `android::validate_apks` 的 Default 模式。传递原单调截止点和只读取消回调；公共库不连接设备、不启动工具、不分配产物 ID、不删除目录。维持已有规则：最多 10000 成员、结构声明体积最多 2 GiB，APKS 压缩输入最多 64 MiB、真实展开最多 256 MiB；拒绝重复成员，要求非空 `toc.pb` 和至少一个带 ZIP 标识的 APK，并完整读取以核验长度与 CRC。不扩展为嵌套 APK 完整清单/签名验证，也不代替 bundletool 的实际设备匹配。

## 旧绑定、准入与兼容变化

格式 2 增加旧名 `android.app.install_apks`，严格顶层输入仍为 `{artifact_id,device_id}`，目标精确为 `android-device` 的 `app.install_apks@1`，输入 `device_envelope`，结果 `value` 且 `wrapped:true`。宿主解包真实 result/artifacts 包装后返回原三字段结果，HTTP/MCP 共用同一次任务和原始旧输入。别名 schema 保留 `InstallApksRequest` 的原 UUID 与 ASCII 设备 ID 资格，不因新插件 serial 更宽而扩大旧入口。

绑定必须显式配置，目标缺失/卸载时旧名不可执行，不调用旧内置侧车。空插件宿主仍可启动；当前加载代的发现和能力观测由宿主负责，插件不自造目录或代次。

| 项目 | 原生产安装 | 迁出后 |
| --- | --- | --- |
| 设备准入 | 合法设备 ID 可直接交工具，未要求宿主当前目录 | 要求提供者当前代、已观测设备、在线且精确能力可用；旧代/未观测/离线由统一准入拒绝 |
| 同设备写锁 | `AndroidSplits` 同实例 APKS 安装按 serial 串行，不覆盖其它动作 | 复用宿主 `(provider_id,local_id)` 跨代身份锁，与 APK、截图、输入、卸载等写动作串行；不同设备可并行 |
| 截止点 | 用例入口只做预检，安装端口内部重新计 120 秒 | 排队、设备锁、握手、配置、副本、校验、Java、结果处理共用原 `D` / 协议 4 本地 `D_L`，不续期 |
| 部署配置 | 宿主 `APK_ADB`、`APK_JAVA`、`APK_BUNDLETOOL_JAR` | 插件旁置配置；宿主不再选择 APKS 工具 |
| 无插件行为 | 宿主内建旧名 | 旧名依赖显式绑定与真实插件目标，无内建回退 |

锁覆盖公开设备动作、直接 jobs/MCP 贡献和旧 alias；插件不加第二把 APKS 设备锁。跨提供者映射为同一物理设备的别名协调仍不属于本合同。新的准入和预算差异须由测试与部署文档明确呈现，不能称为无行为变化的机械搬迁。

## 资源所有权与清理范围

沿用现 Session：每调用最多一个活动阻塞文件闭包，工作持许可、私有目录 lease 和真实句柄至返回。副本刷新、句柄关闭、校验结束与直接 Java 进程真实退出均确认后才允许删除目录；丢弃等待只通知取消，不提前删除仍在用的副本。

首次观察取消/到期或进入收口时固定同次最多两秒清理点。清理不继续业务、不续期、不重新取得窗口；panic、工作/进程未排空、租约未归还、实际目录删除失败或清理点耗尽均保持粘性未确认并报告 `cleanup=failed`。目录实际删除且不存在确认完成后才允许 `cleanup=complete`，未确认时保留目录；无自动删除 Drop 或背景补删。

确认范围为本次直接 Java 客户端、插件拥有的文件与私有目录。bundletool 可派生 ADB 客户端并使用部署者共享 ADB server；直接 Java 退出不证明全部派生进程、server 或设备事务恢复。本批不杀 server、不全局 disconnect、不回滚部分安装，不提高工具库现有直接进程保证。

## 最小写集与职责

| 写集 / 单元 | 负责与输入输出 | 不负责 | 副作用 |
| --- | --- | --- | --- |
| 插件 `src/config.rs`、`config/` 及配置测试 | 解析可选 Java/JAR，核验部署入口，输出固定程序/前缀和绝对 ADB 文件 | 自由参数、业务设备匹配、读取宿主 APK 环境配置 | 受控配置/路径读取 |
| 插件 `src/operations.rs`、`operations/commands.rs`、`lib.rs` | 解析新严格封套、产生 APKS Input、转入 Session；将产物动作排除普通 ADB 分支 | 文件、进程、归档校验和清理 | 无新增副作用 |
| 新 `src/session/install_apks.rs`，调整 `session.rs`、`session/input.rs` | 按固定 APKS 流程准备/校验副本、执行 Java、返回原三字段；复用 Session 的 worker/收口，内部固定选择副本名称 | 新设备锁、任务/产物实体、SDK 协议、扩大 APK 校验 | 受限文件读写、归档读取、工具调用 |
| 新 `src/rules/apks.rs` 及纯规则测试 | 保留合并诊断成功规则，映射公共包规则的固定失败 | 配置、工具启动、目录删除 | 无 |
| 插件 `src/control.rs` | 增加插件私有的指定程序/argv/cwd 捕获入口，复用同租约、原截止点与直接进程确认 | 平台命令构造、新公共 API、共享 daemon 管理 | 受控直接进程 |
| 插件 `src/discovery.rs`、双清单、`aliases.example.json`、`Cargo.toml`、README | 声明新能力与预算，冻结旧映射，直接依赖已存在的 `android-package-core`，同步中文模块说明 | 宿主平台分支、改公共库/SDK或工作区成员 | 元数据/依赖声明 |
| 宿主 `server/src/main.rs`；application 的安装侧车及专属导出/测试 | 撤除 `InstallApksOperations` 生产装配与侧车；撤除 main 中仅服务 APKS 的 Java/bundletool、PackageCapacity 及退出收口 | 删除旧 SplitOperations/AndroidSplits 的兼容回归、修改通用设备/HTTP/MCP合同 | 减少宿主工具与退出资源装配 |
| 插件 `tests/`、假 Java/bundletool、部署与服务 smoke | 检验公开协议、固定 argv、真实 PID、文件字节、错误和共用锁；部署独立配置和旧绑定 | 改生产行为、将模拟设备当真机 | 测试临时目录、独立假工具与真实服务 |

拆分优先：APKS 编排放独立 Session 子模块，诊断规则放纯规则模块；不继续把归档、配置和多工具流程塞入现 `Session::run` 或通用路由。公共 `android-package-core`、`tool-process`、`plugin-runtime`、SDK、domain、前端和生成文件保持现合同。Cargo.lock 仅由主代理集成时更新；新增公共库消费不建立宿主反向生产依赖。

后端代理生产写集限定 `plugins/android-device/` 的生产源码、元数据和说明；测试助手独占该插件 `tests/` 与指定模拟/服务夹具。主代理独占宿主撤除、workspace/Cargo.lock、格式化、构建、服务、分发、根 todo 和交接记录。生产写集释放前仅允许本文更新，不能自行 Cargo 或接手其它代理文件。

## 验证顺序与通过标准

采用 Hybrid：先以现公开输入/结果与纯规则证明兼容，再以独立协议和真实模拟进程证明固定调用与资源收口，最后验证宿主撤除、跨入口锁和正式分发。前端技术栈讨论不阻断本批后端合同；具体业务界面不纳入本批验收。

1. 纯规则和配置：新旧 schema、严格封套/短贡献、UUID、唯一 pointer/ID、`.apks` 文件名、Java/JAR 配置缺失/非法路径；旧空输出、普通输出、任一路失败子串和 UTF-8 lossy 行为。复核 APK 原 Success 规则和其它动作配置不受影响。
2. 包与副本：真实大小/SHA256、独立 `input.apks` 字节、源不是普通文件/祖先链接或重解析点、无副本时不启动；坏 ZIP、空/缺 toc、无 APK、坏 APK 标识、重复成员、CRC/长度和压缩/展开限额。沿原 deadline 和取消回调验证停止，不增加完整嵌套 APK 检查。
3. 独立协议/假 Java：完整固定 argv、绝对 ADB、JAR路径含空格、cwd与三项临时环境、两流 1 MiB、零退出空输出成功、非零退出/失败文本/取消/到期失败；在副本/校验/工具不同阶段取消、丢弃等待和 panic，核对真实 PID 退出、文件工作排空、目录删除或保留、粘性 cleanup 结果及输出产物为空。
4. 宿主真实 HTTP/MCP：空插件启动、旧名不内建；加载/发现后新能力与旧 alias 均可调用并保留原结果；当前代/未观测/离线精确拒绝。旧 alias、直接贡献和公开设备动作与 APK/截图等共享同设备写锁，不同设备可并行；锁等待消耗原预算，取消后不执行；卸载撤销贡献，重载换代，旧引用拒绝，任务历史保留，无静默回退。
5. 主代理执行 backend/AGENTS.md 必需架构、fmt、Clippy、workspace 测试与构建；涉及服务/设备/退出的 runtime 两模式、日志、生命周期、合作取消、在线插件、设备提供者与嵌套产物门禁按范围执行。新 APKS 定向 smoke 与必要通用回归分别记录，当前 debug 与 release 产物分别重建验证，正式 npx 包实际安装新版插件、配置工具并验证旧/新入口，不能复用旧包通过记录。
6. 真机另取 bundletool/Java/ADB 版本、真实 APKS 的指定设备匹配安装、授权/离线/不兼容包和取消证据。模拟工具只证明传输、参数、文件与宿主生命周期；不证明安装事务、全部派生树、共享 server、其它平台或性能。

当前证据仅为既有源代码与合同的只读核对。本裁定未对应新的 Cargo、协议、HTTP/MCP、debug/release、npx 或真机通过记录；实施与验证完成后由主代理更新实际覆盖和剩余边界。
