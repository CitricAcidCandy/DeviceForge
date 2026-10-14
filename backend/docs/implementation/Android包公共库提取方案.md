# Android 包公共库提取方案

状态：独立设计建议，公共库 API、错误和依赖门禁待主代理冻结。本次仅新增本文件，不提取源码，不改变现有协议或时间语义。日期：2026-10-09。

## 目标、范围与当前证据

依据 [平台适配器迁出实施](平台适配器迁出实施.md)，Android 设备插件与包工具插件需要共享受限容器处理和解析，不能通过引用宿主 infrastructure 复用旧业务。候选落点沿用 `crates/android-package-core`；内部按 ZIP 封装、Android 解析分模块，工具 argv 和宿主产物处理分别留在插件与宿主。名称和拆库粒度仍待主代理冻结。

长任务契约见 [非设备长任务执行期限方案](非设备长任务执行期限方案.md)，仍未冻结。本方案不接受其中建议数值为已生效规则，不通过提取暗中修改旧 120 秒分段/总期限。设备 API 2 预算及现有嵌套产物选择继续遵守各自冻结契约。

下列为源码只读证据，不是本轮测试通过记录：

| 现有文件 | 已核对的职责/依赖 | 提取边界 |
| --- | --- | --- |
| [artifacts/validation.rs](../../crates/infrastructure/src/artifacts/validation.rs) | ZIP 尾部/中央目录预检、条目路径/链接、声明体积、分页；另有 PNG/内容校验；依赖 domain 产物类型 | 只提取通用 ZIP 机制；分页 DTO、媒体分派和 PNG 不整体搬入 Android 库 |
| [package_tools/manifest.rs](../../crates/infrastructure/src/package_tools/manifest.rs)、[signature.rs](../../crates/infrastructure/src/package_tools/signature.rs) | XML 与 apksigner 文本纯解析，但结果含宿主 artifact_id/domain 类型 | 解析数据与产物归属拆开，核心不导入宿主实体 |
| [package_tools/mod.rs](../../crates/infrastructure/src/package_tools/mod.rs) | 工具固定前缀、产物 materialize、精确 APKS 条目提取、阻塞解压、发布 | argv 归插件；容器复制可复用；ArtifactStore/ID/SHA-256/发布归宿主 |
| [bundles/validation.rs](../../crates/infrastructure/src/bundles/validation.rs) | APKS 模式、重复条目、外层成员长度/CRC、toc.pb 与 APK 标识；引用宿主 BuildMode | Android 容器规则可共享，输出值去宿主类型；不宣称解析了 toc.pb 匹配语义 |
| [reverse/scanning.rs](../../crates/infrastructure/src/reverse/scanning.rs) | smali 根目录、SDK 规则/排序证据，读取 ZIP 目录；依赖 domain SdkRule/SdkScan | 有界 Android 路径解析可共享，不升级为 DEX 分析或 SDK 版本识别 |
| [reverse/packing.rs](../../crates/infrastructure/src/reverse/packing.rs)、[splits/packing.rs](../../crates/infrastructure/src/splits/packing.rs) | 相近受限目录扫描/Stored ZIP 打包；各有业务必需文件、条目数和结果差异 | 合并机制但保留 profile 与业务验收，不用一个宽松默认抹平差异 |
| [artifact_files/mod.rs](../../crates/infrastructure/src/artifact_files/mod.rs) | 宿主产物复制、大小/摘要校验、临时目录及删除重试 | 不整体提取；复用 lease 思想，不把删除重试当资源排空证明 |

## 四个域的输入、输出与副作用

以下是语义约束，不是已冻结函数签名或公开 JSON 字段。

| 域 | 输入 | 输出 | 错误责任 | 副作用与禁止事项 |
| --- | --- | --- | --- | --- |
| ZIP 封装机制 | 借用的 Read/Seek 或受控本地文件句柄、精确条目名；受控目录/输出句柄；显式 profile、取消检查和绝对点 | 有界目录描述、选定条目复制结果、已完成 ZIP 的文件计数/字节数/排序条目 | 区分坏容器/路径/链接/重复、缺条目、超限、CRC/长度损坏、I/O、取消/到期 | 允许同步受控 I/O；不 spawn、读环境、取服务器路径或创建宿主 Artifact |
| Android 解析与容器规则 | 有界 XML/签名文本、Android 模式、已校验目录/成员数据、SDK 路径规则 | 无 artifact_id 的清单/签名/SDK 观测值，APKS 校验摘要 | 区分无效业务参数与工具响应/包格式错误；不能用“工具退出 0”代替业务校验 | 文本规则无副作用；读容器只通过封装层；不执行 Java/ADB，不访问 HTTP/数据库 |
| 工具 argv/插件编排 | 部署者固定 executable/前缀、已授权本地副本、业务参数和总点/取消 | 固定参数数组、受控工具输出、插件业务 result/outputs | 公共 tool-process 错误加业务诊断；映射为插件协议结果 | 启动工具是插件责任；不提供 shell，不让业务请求选择程序、签名材料或输出目的目录 |
| hostartifact/任务 | 浏览器产物 ID、冻结 selectors 声明、owner/generation、受限输入/输出列表 | SDK 本地副本上下文、宿主真实产物列表、原任务终态 | 宿主存储/清理/准入及产物校验错误 | 宿主拥有摘要、ID、发布与历史；公共库不 resolve ID、不 put、不加载贡献、不创建第二 Job |

建议 ZIP 核心提供同步受限操作，调用方负责线程和容量。路径参数仅来自调用方已建立的私有目录/受控文件，不是新的 HTTP 路径入口；借用句柄不转移调用方目录所有权。核心如需临时文件，须由调用方授予位置并返回仍受 lease 管理的结果，不能自行扫 TEMP 或删除任意父目录。

工具命令仍是平台业务：apkanalyzer manifest print、apksigner verify、bundletool dump/build/extract/install、apktool decode 的 argv 分别放所属插件。APKS `install-apks` 归 Android 设备插件并受宿主共享设备锁；构建、反编译和离线规格提取归包工具插件，不持设备锁。

## 候选模块与准确迁移来源

| 候选落点 | 单一职责 | 现有来源/适配点 |
| --- | --- | --- |
| `android-package-core/src/lib.rs` | 仅有限导出和模块边界，不汇总业务编排 | 新文件；不导出宿主端口 |
| `src/error.rs`、`limits.rs`、`control.rs` | 独立错误、profile 校验、同步取消/截止点检查 | 提取机制的公共边界；不复制 host Error 或创建 Tokio Runtime |
| `src/archive/{preflight.rs,paths.rs,index.rs}` | 尾部/中央目录、通用路径与条目描述，结构检查 | artifacts/validation.rs 中 ZIP 部分；不包含 ArchivePage/媒体判断 |
| `src/archive/{copy.rs,tree.rs,packing.rs}` | 精确复制、受控目录检查、限额写入/Stored ZIP | package_tools/mod.rs 提取循环及两处 packing；业务规则移出机制 |
| `src/android/{manifest.rs,signature.rs,models.rs}` | XML/签名解析及独立数据值 | package_tools/manifest.rs、signature.rs；去 artifact_id 与 domain 依赖 |
| `src/android/{apks.rs,smali.rs}` | APKS 内容规则、SDK 路径匹配 | bundles/validation.rs、reverse/scanning.rs；不搬工具和库外存储 |
| `src/archive/tests.rs`、`src/android/tests.rs`、根 README | 有意义规则/坏容器回归和依赖/副作用说明 | 迁移现 fixtures 并保留旧宿主适配回归，不原样镜像实现 |
| `plugins/android-packages/src/{tools.rs,manifest.rs,signature.rs,bundles.rs,reverse.rs,splits.rs}` | 配置/argv、公开输入校验、执行和业务结果；再按规模拆文件 | 旧 package_tools/bundles/reverse/splits 的非设备业务编排 |
| `plugins/android-device/src/install_splits.rs` | APKS 安装 argv、受控参数与协议取消 | splits/mod.rs 的安装路径；不能携带旧局部锁冒充全局互斥 |
| infrastructure 过渡适配器 | 公共错误/值到旧 domain 端口转换，保持旧结果 | 旧模块改为薄适配后逐步撤除；不允许插件反向依赖它 |

候选文件均待重新分配写范围，不是本批实施授权。公共库不能只把旧文件换目录：现 parse(id,...)、host Error、ArtifactStore、LIMIT 引用和业务必需文件逻辑都须显式解耦，保留兼容转换测试。

## 依赖白名单与错误适配

| 单元 | 候选生产依赖白名单 | 明确禁止 |
| --- | --- | --- |
| 公共包核心 | 标准库、`zip`、`quick-xml`；独立错误可用 `thiserror`；需要输出值序列化时有限使用 `serde` | domain/application/infrastructure/server、HTTP/SQLite、平台工具包、进程/运行时装配和环境读取 |
| ZIP 机制模块 | 标准库 I/O/文件系统及 zip；从调用方接控制检查 | Android XML/签名模型、APK 扩展名分支、宿主 Artifact/ArchivePage、PNG 与 TGZ 安装 |
| Android 解析模块 | 核心独立模型、quick-xml、ZIP 机制；SDK 路径规则只用标准集合 | 宿主类型、工具进程、设备锁、ArtifactStore 和自有后台任务 |
| 独立 Android 插件 | 公开 plugin-sdk/plugin-runtime、tool-process、包核心，以及业务必要 serde/json、Tokio、受限临时目录组件 | 宿主四层 crate；调用者选择 executable 或带入宿主凭据 |
| 宿主过渡适配器 | infrastructure 可引用公共库，仅做错误/数据适配及通用产物职责 | application/domain/server 引用包核心；最终通用宿主继续装配平台工具 |

初步复用当前 zip 8.6、关闭默认特性并保留 deflate，quick-xml 0.42；不是批准升级版本或新增解压算法。新增依赖/特性需主代理同步 Cargo、锁和架构门禁。取消适配建议用同步检查回调/轻量控制值，核心不因此引入 Tokio 或创建阻塞池；确切端口待冻结。开发测试可用临时文件组件，集成测试可引用宿主，但这些许可不得变成生产反向依赖。

通用宿主若复用 ZIP 底层，只能调用无平台分支的封装接口；Android 解析留插件。若主代理选择分成独立 archive crate 与 android-package-core，则仅改变库之间的分层引用，不把业务规则复制两份。工具进程能力只来自已有 tool-process，包核心不另写 process helper。

建议独立错误表达以下语义，具体枚举/字段未冻结：

| 核心错误语义 | 必须携带的有限信息 | 调用层适配与旧行为 |
| --- | --- | --- |
| 参数/profile 无效 | 规则原因，不含任意工具文本或凭据 | 旧调用为 Invalid/invalid_input，不启动 I/O |
| 容器/解析格式错误 | 格式类别和有限位置/条目标签；区分结构与 CRC/长度损坏 | 输入 ZIP/APKS 损坏沿原 Invalid；manifest/signature 的坏工具文本沿原 Dependency，不统一改成同一类别 |
| 精确条目缺失/重复 | 受限条目标签、缺失或不唯一 | 旧选定 APKS 条目缺失 NotFound，重复 Invalid；不自动挑第一份 |
| 超限 | 限制种类与有效上限，实际计数允许饱和 | 原文件/容器 TooLarge；工具输出 1 MiB 超限仍由 tool-process/调用层映 Dependency，不混为包核心错误 |
| 文件 I/O | 阶段与原 io::Error，避免拼接敏感路径到协议 | 原 Storage；进程 Spawn/ProcessIo 仍是 tool-process 的职责 |
| 打包期间变化 | 条目改变或大小不一致 | 原 Conflict，不能输出成功 ZIP 摘要 |
| 取消/到期 | 检查到的控制原因 | 调用层映 Cancelled/Timeout；不由解析器声明 CleanupFailed 或清除资源标记 |

核心错误不包含 HTTP 状态码，也不直接序列化成新 SDK 响应。host 适配器保留当前类别/关键旧文案；插件按既有 Response.error 字符串报告失败，不能宣称已经有完整平台结构化错误。APKS 工具输出验证的既有 Invalid 与其它工具响应 Dependency 差异先保留，是否统一另走契约，测试不得接受任意 4xx。

## ZIP 机制与业务 profile 不能混淆

| profile/检查 | 保留的现边界 | 核心与调用方的责任 |
| --- | --- | --- |
| 通用 ZIP 结构检查 | 最多 10000 条目、声明展开量最多 2 GiB；拒绝分卷/ZIP64、越界路径、符号链接及无效目录范围 | 通用机制；不表述为逐成员 CRC 或可信 APK 证明 |
| 选定 APKS APK 提取 | 精确唯一名称；名字有界、路径安全、APK 扩展名；单文件最多 64 MiB | 核心复制并读到 EOF/CRC，调用方决定 APK 业务资格和受控输出名 |
| APKS 构建/源校验 | 压缩文件最多 64 MiB、外层累计展开最多 256 MiB、拒绝重名；完整读取外层成员并检查长度/CRC | Android 模块要求非空 toc.pb、APK ZIP 标识；universal 模式要求唯一 universal.apk；不声称完整解析 toc.pb 或所有 APK 内层 CRC |
| reverse 输出树/打包 | **10000** 个文件/目录条目、深度 128、普通文件总量及最终 ZIP 各 64 MiB | 封装机制参数化；调用方最终要求非空 apktool.yml/AndroidManifest.xml；轮询期不要求工具已生成全部文件 |
| splits 提取输出树/打包 | **1000** 个文件/目录条目、深度 128、普通文件总量及最终 ZIP 各 64 MiB | 最终只允许 APK，结构校验且不为空；返回排序 APK 名称；不沿用 reverse 的必需文件规则 |

目录扫描计数包括文件和目录，不能只计成功写进 ZIP 的文件。Stored ZIP 保持排序写入、create_new、分块复制、实际长度与扫描值一致、完成后 sync；写入限额包含头部/中央目录，不能只限制源文件字节和。业务摘要仍分别为 reverse 的 files/unpacked_size 与 splits 的 apk_entries，核心只返回足以适配的独立值。

路径机制保留根目录/子项链接、重解析路径和非普通文件拒绝，禁止绝对路径、反斜杠、冒号、控制字符及点路径穿越。ZIP 条目不直接变成服务器目录树，精确提取目的名由调用方授予。扫描至打开之间存在并发替换边界，不能把 canonicalize 检查写成操作系统隔离或完整竞态免疫；若需要句柄级保证须另冻结能力，不默默增加平台原生 API 依赖。

结构目录检查、完整成员读取和 Android 业务验证应是可区分操作，不使用模糊的“已校验”布尔结果混为一谈。SDK smali 扫描当前只消费目录路径，不能改成要求读取全部 smali/内层 CRC 而声称零兼容影响。包核心不承诺扫描恶意代码、验签真实性之外的信任审批或真机可安装性。

## Android 解析兼容与工具边界

XML 解析保留最多 1 MiB、20000 节点、128 层，按 Android 命名空间读取版本/SDK/标签/debuggable/权限，拒绝 DTD、未定义实体、命名空间歧义及重复主要结构。完整 XML 可以是有界业务结果，不能在日志中任意记录；资源标签不自动解析。核心结果移除宿主 artifact_id，调用层依据原输入补归属，不改变其它已公开值的缺省/字符串语义。

签名解析保留明确 Verifies、至少一个成功方案、完整连续编号签名者和 64 位十六进制 SHA-256；失败诊断不能因进程零退出而成功。report 警告保持原语义，不自动开启 -Werr，不扩展为 AAB JAR 签名/APKS 所有分包签名。受控临时路径到展示文件名的替换在插件/适配器完成，核心不查宿主元数据。

smali 规则保留最多 100 条唯一名称、包/类标识约束、合法多 DEX 根、包边界匹配、最多 10 条排序证据及指定检测点必须出现在证据中。不会把同前缀其它包算命中，不把路径存在解释成 SDK 版本、运行状态或 DEX 二进制内容已分析。

工具插件复用 tool-process 的独立 argv、受限环境、两路输出限额、截止点和直接进程清理，不把 ToolCommand.output 原本固定 120 秒计时照搬为新总预算。Java 固定前缀 `-Xmx256m -jar` 与管理员配置兼容性分别验收；Windows 不增加自动执行 bat/cmd 或 shell 的回退。APK/AAB/module 参数验证仍属于 Android 业务规则，输入路径只能取 SDK 授权副本。

签名配置/材料由部署者提供，不进入业务 schema、日志或任意 stdout/stderr 回传。工具的固定失败诊断与非零退出处理留调用层，库不默认拼接两路输出：XML 需要原标准输出，splits 的工具诊断要保留原零退出但 FAILED 的拒绝语义。受限工具环境不证明独立进程是系统沙箱，也不授权卸载杀部署者共享 daemon。

## CRC、取消、阻塞许可与目录 lease

1. 调用方先验证公开输入与 host selectors，再取得包处理工作名额；core 的 profile/参数检查应在创建文件前拒绝。精确成员的零/多匹配在目的文件创建前决定；不碰未声明产物或挑第一条重复成员。
2. 核心同步 I/O/CPU 工作由调用方放入受限阻塞池，不能在线程运行时再自行 spawn 一份无界工作。建议插件进程内固定正数名额，过渡宿主同样有界；准确容量由第 3 项冻结选择决定，不能只依赖“单个 Job”忽略监测与打包并行。
3. **许可与目录 lease 一起移入阻塞闭包**，跟随真实工作退出。取消请求 Future 后，闭包仍占槽并持有目录；严禁外层 guard 提前 drop 后闭包继续写文件，或取消等待即可绕过上限。core 只借用资源，删除权归调用方。
4. 当前约 64 KiB 复制块、目录遍历及成员循环均复核取消；候选控制还接受父绝对 deadline，并在下一 I/O/解析批次前复核。Some(D) 必须逐成员共用；None 的兼容计时由调用层保留。长任务契约未冻结前不能启用新普通预算，也不能每成员重新起 120 秒。
5. ZIP 成员必须实际读取到 EOF 才报告完成/CRC 通过，核对声明和实际长度及累计上限。取消、到期、读取/CRC 错误不得返回部分成功；pack 完成头部/目录收尾、sync 且校验大小后才授予完整结果。临时半文件只由所有者回收，不变成宿主公开产物。
6. 不可中断 I/O/解析可能晚结束；取消只请求停止，外层 timeout 不能证明闭包已退出。循环检查提供合作边界，执行到期后不准入新工作；许可、lease 及待排空跟踪保留。库不承担进程 kill/协议 3 清理，调用层分别等待并保存风险。
7. 正在使用输入/输出目录的工具进程、阻塞监测、压缩和发布流各持所需 lease。目录只能在这些使用者完成后清理；不能原样复制宿主 Temporary 的后台删除重试，就声称插件卸载已经排空。重试/失败需要调用层有界跟踪，不删除用户文件或进程共享目录。

公开结果到 hostartifact 的边界不变：SDK inputs 是宿主已复制授权的输入，plugin outputs 只返回有限文件名。宿主统一验证输出目录、文件/链接、大小及媒体类型并原子发布真实 Artifact；库和插件不能提交伪 Artifact ID/哈希实体来充当宿主发布证据。旧别名的 Artifact 投影仅从真实宿主包装列表唯一匹配，files/size 等独立业务值可有限投影。

逐产物发布不是批量事务。后续产物到期可能保留先已发布项，应按现协议记录边界，不宣称提取库解决了回滚或孤立产物回收。进程/外部资源未确认继续沿宿主 unresolved/Draining/cleanup_failed 准入门禁，核心完成 CRC 或普通解析成功不得清除该风险。

## 最小实施顺序

先冻结独立错误/模型、profile 和依赖范围，并建立纯容器/解析行为回归；再提取公共机制、由旧 infrastructure 薄适配验证行为一致。第三步接独立 Android 包工具/设备插件，分别校验 argv、产物上下文、共享锁和取消；总期限接入等待所属契约冻结。最后主代理撤除平台直接装配、同步架构/生成/分发门禁。

空插件宿主无 Java/ADB/Apktool/签名配置仍能启动，未部署能力明确不可用，不静默回退内置实现。独立插件即使本机没有工具也应能完成协议启动/声明，实际调用缺配置明确失败；不得把管理员环境探测移入通用宿主启动检查。仅文件搬迁、纯规则通过或模拟工具成功均不能宣称平台迁出完成。

## 最小回归矩阵

所有条目待主代理安排执行；本批不运行 Cargo/npm/fmt、真实进程、包工具或服务。长任务相关行仅在契约冻结后实施。缺工具/真实样本时明确未执行，不能把跳过写成通过。

| 编号 | 证据层/场景 | 必须观察的结果 |
| --- | --- | --- |
| APKCORE-01 | 静态/依赖 | 核心无宿主生产依赖、进程/HTTP/DB/环境副作用；插件只链接公开库；宿主只保留通用产物与过渡适配 |
| APKCORE-02 | 纯 ZIP/路径 | 恶意点路径、绝对路径、反斜杠、重名、链接、分卷/ZIP64、无效目录与声明体积按原 profile 拒绝；参数坏不建目标文件 |
| APKCORE-03 | 真实文件/CRC | 修改压缩成员数据而保留可读目录；结构检查不冒称 CRC，选定复制/完整成员校验确定失败，不返回部分成功 |
| APKCORE-04 | 纯 APKS | 缺/空 toc.pb、无 APK、重复条目、坏 APK 标识、长度/展开量越界、universal 模式错误拒绝；不以标识头当内层完全校验 |
| APKCORE-05 | 真实目录/profile | 相同合规目录超过 1000 未超 10000，reverse 与 splits 保留各自边界；统计目录、深度、64 MiB 源/最终 ZIP；各自业务必需文件规则保持 |
| APKCORE-06 | 真实目录/变化 | 链接/重解析/非普通文件及打包期间扩长/缩短失败，排序/Stored/create_new/sync 保持；输出监测不声称硬磁盘配额 |
| APKCORE-07 | 纯 XML/签名 | 命名空间/DTD/重复结构、节点/深度/体积边界；签名失败诊断、方案/连续编号/证书指纹规则；旧 domain 适配不丢字段/缺省值 |
| APKCORE-08 | 纯 SDK 路径 | 多 DEX 根、内部类、前缀包边界、指定检测点与 10 条证据排序；只目录观测不声称内容/版本判断 |
| APKCORE-09 | 适配/错误 | 缺成员 NotFound、重复/坏 APKS Invalid、坏解析输出 Dependency、文件 Storage、大小 TooLarge、变化 Conflict 保持；取消/到期分类固定 |
| APKCORE-10 | 受控阻塞/丢弃 | 取消外层 Future 后未退出闭包仍占许可/lease；重复取消不能超池容量，不删除在用目录；放行后才回收 |
| APKCORE-11 | 真实独立模拟工具 | CARGO_BIN_EXE 或明确构建产物记录 argv/空格/中文路径/固定前缀/cwd；不经 shell，凭据不进环境/日志；零退出 FAILED/无输出明确失败 |
| APKCORE-12 | 真实进程/取消 | 运行取消、期限、Future 丢弃、stdout/stderr 超限覆盖退出 PID 与目录使用；协议 3 cleaned/failed/ignore 分别观察，不能只查任务终态 |
| APKCORE-13 | 真实 APK/工具 | 受控真实 APK 经 apkanalyzer、apksigner、apktool；已知包名/版本/SDK/证书与完整 XML/反编译 ZIP 一致；unsigned/损坏样本失败 |
| APKCORE-14 | 真实 AAB/APKS | 已知真实 AAB 的 default/universal 构建及规格提取；选择成员完整读取/CRC、APKS 内容/排序/数量正确；实际安装与高级匹配另需真机门禁 |
| APKCORE-15 | 真实宿主/跨端 | native/Node 独立插件经 HTTP/MCP/别名执行；只声明产物可读、宿主真实输出列表/哈希匹配；APKS 安装复用设备锁/代际，卸载取消与未确认门禁保持 |
| APKCORE-16 | 期限/空部署/分发 | 冻结后输入/工具/阻塞/发布共用 D；空插件无工具可启动；debug、新 release/npx 独立实测，不拿旧包或模拟工具替代真实包/真机 |

纯库测试与真进程测试分开：ZIP/解析边界可用受控文件和坏数据，进程回归需真实子进程观察。真实包测试须记录样本来源/摘要、工具版本、已知期望、模式、命令、退出码和报告；真实 FPS、iOS、Harmony、长期连接与平台真机不在本批完成范围。发布阶段继续执行所属完整门禁及受影响 smoke，不由本角色并行抢构建锁。

## 最多三项待主代理冻结选择

1. **库粒度、独立模型与依赖**：沿用 android-package-core 的 archive/Android 两层，还是将通用 archive 独立成库；确定导出值、可选序列化与白名单。推荐先按本文分域，只有清楚复用需求才新增第二 crate；任何方案均去宿主 artifact_id/端口依赖，argv 不入核心。
2. **profile、校验层级与错误兼容**：确定结构/完整 CRC/Android 业务的分离接口，以及旧错误适配。推荐显式 profile，严格保留 reverse10000/splits1000、现有大小/深度和各自必需文件规则；不默默扩大 CRC 范围或改变旧响应类别。
3. **执行包装与资源所有权**：确定调用层阻塞池容量、控制检查、目录 lease/待排空责任及长任务接入批次。推荐许可与 lease 入闭包、所有使用者归跟踪、期限统一继承；长任务数值/公开端口按所属契约冻结，不在提取中另造预算或清理成功证明。

本文件冻结的是设计稿。公共包库提取、旧适配撤除、独立插件、真实包、release/npx 与真机验收均未由本次完成。
