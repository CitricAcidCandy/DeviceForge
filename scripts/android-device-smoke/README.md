# 安卓设备真实宿主驱动

本目录属于独立验收，不导入安卓插件业务实现。默认严格消费冻结的十一贡献/十能力版本；`--performance` 严格消费当前十二贡献/十一能力版本。主代理完成对应后端构建后再执行；脚本存在或语法通过不代表服务通过。

## 主代理执行

```powershell
rustc --edition=2024 scripts/android-device-smoke/fake-adb.rs -o artifacts/android-device-fake-adb.exe
node scripts/android-device-smoke.mjs --tool-binary G:/Rust/DeviceForge/artifacts/android-device-fake-adb.exe
node scripts/android-device-smoke.mjs --release --tool-binary G:/Rust/DeviceForge/artifacts/android-device-fake-adb.exe
node scripts/android-device-smoke.mjs --performance --tool-binary G:/Rust/DeviceForge/artifacts/android-device-fake-adb.exe
node scripts/android-device-smoke.mjs --release --performance --tool-binary G:/Rust/DeviceForge/artifacts/android-device-fake-adb.exe
```

依赖 Node 全局 fetch、已有同 profile 的 apk-server、validate-plugin、deviceforge-android-device-plugin，以及本目录 std-only 假工具。每次修改假工具后重新编译；同轮只编译一次，驱动将同一二进制复制为独立假ADB和假Java入口，通过固定argv分支观测实际调用，不新增Java命令行参数。驱动自身不执行 Cargo、rustc、npm 或生成器，不使用用户运行中的服务。默认免鉴权，回环临时端口、独立数据和部署目录，显式复制格式2 aliases。

可通过 `--source-directory <绝对路径>` 指定当前冻结十一贡献/十能力元数据目录。该目录只读取 `package.json`、双清单、`aliases.example.json` 与 README，原binary仍须与清单逐字节核对。驱动按名称严格核对十一贡献、十能力及十一别名，八贡献与十贡献旧快照均不能通过。

`--performance` 禁止同时使用 `--source-directory`，必须读取当前性能插件元数据，防止新二进制混入旧APKS快照。该模式给自有宿主显式传入 `APK_PERFORMANCE_PLUGIN=android-device`；默认模式不注入性能来源。性能模式保留原APKS全阶段及60个Job/57个工具基线，再执行性能业务与整体核对。独立的APKS成功报告不能转计本轮性能通过。

ADB、Java与占位bundletool JAR由部署者写入实际插件二进制旁的 `portable/bin/android-device.config.json`。分阶段配置原子替换，验证缺工具后再启用完整APKS配置；不更改原包成员、清单或既有执行预算。

## 责任

| 文件 | 责任 |
| --- | --- |
| 根入口 | 参数、冻结输入、串行编排、自有宿主与报告 |
| deployment | 源双清单、显式绑定、当前原binary、便携部署、真实validator及身份复核 |
| bootstrap | 公开目录、当前owner/generation与未配置ADB精确失败 |
| fixtures / fake-adb.rs | 独立ADB/Java双入口、旁置工具配置、原子门闩、实际argv/父插件路径/直接PID与退出意图 |
| jobs | 同Job双端历史/事件、唯一终态、冻结历史、默认60个Job/57个工具与性能整体99个Job库存 |
| discovery | refresh/direct/alias，HTTP/MCP各一Job/一工具与本次目录 |
| actions | 原七能力固定argv/结果、精确错误、十一贡献无内置回退、原共享锁 |
| artifacts | 安装/截图的HTTP及MCP能力与旧别名、私有副本、下载原字节、共享锁与取消 |
| apks-fixtures | 独立APKS内外层ZIP、完整SHA、固定Java argv、私有副本和Windows路径规范化 |
| apks | APKS资格失败、准入拒绝、HTTP/MCP三类入口、空/损坏UTF-8输出与在途取消 |
| apks-locks | APKS与APK/截图的双向共享写锁、三类入口串行及另一设备并行 |
| lifecycle | APKS及截图两轮在途卸载、旧代四类动作和新代未发现APKS拒绝、新代发现及历史/产物保留 |
| performance-fixtures | 独立五笔采样argv与原始数值、同父PID样本分组、完整和取消工具观察 |
| performance | 显式来源缺失、准入、四类直接采样、device/read并行及provider/write屏障 |
| performance-lifecycle | 八会话入口、CPU差分与恢复基线、Running/Paused卸载、换代来源和分页历史 |
| evidence | 递归实际import输入摘要、逐Job及后台会话来源关联日志、报告与原件保留 |

## 必须通过

新宿主未部署插件时十一旧名及十一新贡献均缺失，HTTP 404/not_found，MCP not_found，零Job/零工具。真实validator为11贡献，load为协议4/API3/11贡献/10能力，在线设备有八项可用device能力，旧名仅由显式格式2 bindings恢复。未配ADB为精确依赖错误。三类发现各HTTP/MCP一次，每次一个Job、一个工具、当前generation及本次discovery_job_id，旧发现投影保持完整数组。

原七能力分别验证实际固定argv和结果，合法failed包名成功；准入错误核HTTP精确状态和MCP领域码，拒绝不建Job、不启工具。安装与截图各覆盖HTTP/MCP能力和旧别名，共八个成功Job；安装实际读取私有input.apk并核原APK字节及完成后删除，业务结果不泄漏私有路径；截图核唯一宿主产物、文件名、大小、摘要及原pixel.png下载字节。

APKS使用独立合成ZIP，非空 `toc.pb` 与内层APK均保留原字节。公开 `app.install_apks@1`、直接贡献和旧alias各经过HTTP/MCP，一次一个Job和一个Java；新入口验证中文serial原文，旧alias保留ASCII设备ID并精确拒绝中文serial。缺JAR及缺Java各一失败Job、零Java，精确依赖错误与scratch清理。固定七项Java argv包含绝对ADB和私有 `input.apks`，实际cwd与TEMP/TMP/TMPDIR均为同一私有目录；核完整SHA、完成后删除和结果三字段，空stdout及损坏UTF-8 stdout的成功退出仍成功。

门闩保留原设备动作/直接jobs/旧alias共享同设备写锁、不同设备并行、提供者写屏障阻塞设备读写。原产物组仍以三个Job核安装、截图和input共享写锁；安装与截图各一个在途取消Job。APKS组另以九个Job核APKS先持锁阻塞APK、截图及另一APKS，另一设备并行；反向核APK和截图各自阻塞APKS。三等待者实际工具时间逐项不重叠，安装副本与截图下载均逐字节核对。

APKS另覆盖一个在途取消Job，观察直接Java/父插件PID消失、未释放门闩、私有副本删除及scratch清空。生命周期保留原截图在途卸载，并新增APKS在途卸载；两轮均换代重载。卸载后十一贡献均无内置回退，旧代input、APK安装、截图与APKS在HTTP/MCP均冲突拒绝且不建Job、不启工具；新代未发现设备时APKS同样冲突拒绝。重新发现后历史、输入APK/APKS及成功截图保持可读与原字节一致。

完整驱动严格核60个唯一Job、57个唯一工具，其中14次Java、43次ADB；终态为51成功、4预期失败、5取消。三个缺配置Job均无工具调用，实际宿主Job列表与报告逐项相同，所有观察目录与Job工具一一对应。

成功要求自有宿主正常exit0、监听释放、所有HTTP/MCP响应log_id落盘、每Job唯一plugin_request_id开始/结束配对，以及实际读取输入前后零差异。报告写入每轮独立 artifacts/android-device-smoke-{debug|release}-{run_id}/report.json，临时原件始终保留；首次失败不被清理错误覆盖。标准输出仅保留通过状态、报告路径、首失败阶段、固定断言标签和错误类型。

## 性能模式必须通过

当前双清单必须为协议4、设备API3、十二贡献、十一能力；在线设备末尾新增第九项 `performance.sample@1`。采样仅使用 `device/read`、10000ms及 `PerformanceAccess`，原十一条bindings与APKS预算不变，`android.performance.sample` 旧别名始终不存在。直接贡献输入为 `{device_id,input:{package}}`，输出严格为 `{result:原始样本,artifacts:[]}`。

显式来源未加载时宿主仍能启动；start与capabilities各创建一个失败Job，错误必须为 `资源不存在：性能采样源不可用`，零工具。HTTP/MCP分别走设备能力与直接贡献，四个Job每次真实调用五笔固定ADB：pidof、进程stat、meminfo、再读进程stat、系统stat；同父插件PID分组并核对包名、argv、原始tick、PID、启动tick、CPU核数和PSS/RSS。版本、离线、旧代、未知封套和非法包名须精确拒绝且零Job/工具。

采样已持有 `device/read` 时，同设备 `app.stop` 写工具必须先于采样门闩释放完成；provider/write已持有时，采样read必须等待且不启动工具。该断言验证当前锁合同，不延伸为真机调度或性能证明。

八个内置会话入口均覆盖HTTP/MCP。直接采样不创建会话历史；后台采样不创建嵌套Job。普通会话核初样本CPU为空、第二样本CPU份额10%与核百分比20%，暂停排空、两次恢复后首样本重新清空CPU基线，以及stop幂等。驱动等待目标完整工具组后的下一组pidof启动，随后通过pause/stop返回的权威samples计数及实际分页断言落库；下一次工具启动仅作同步线索，不单独充当持久化证明。Running与Paused会话各经过在途工具和卸载，旧会话变为Interrupted；两轮重新加载均核旧代拒绝，新会话只绑定新代。最终卸载后仍能读取四个会话、不可变来源、原请求、终态及完整样本分页历史。

默认输入冻结集合仍为35项；性能模式显式加入三个动态模块，共38项。性能新增39个唯一Job，其中28个内置会话Job、11个插件Job，终态35成功/4预期失败；新增35个直接与发现工具，再加后台实际工具。整体严格99个唯一Job，86成功/8预期失败/5取消，宿主完整列表不得截断。后台采样次数按真实同父PID分组逐项核对，不硬编码，也不套用单Job单工具关系。

性能工具观察目录单独有界至4096项，原件索引单独有界至32768条；默认APKS仍使用100个工具目录和512条原件索引。容量涵盖普通会话三段120秒运行、新代会话120秒运行及两个卸载会话的保守工具上界，仅调整验收夹具容量，采样10000ms、APKS预算、两秒清理和十秒卸载不变。

日志核原60个APKS插件Job及11个新增前景插件Job的独立request_id开始/结束配对，28个内置会话Job仍核历史与响应日志。后台插件日志必须带真实 `session_id`、`source_plugin_id`、`source_generation` 与 `plugin_request_id`，来源逐项符合不可变会话绑定；工具组以同一会话和实际时间区间唯一关联调用。零工具后台调用只允许取消，取消部分组必须有对应取消日志。没有截获插件stdin原帧，不将时间关联称为原帧捕获。

性能报告单独写入 `artifacts/android-device-performance-smoke-{debug|release}-{run_id}/report.json`。本驱动不承担未配置性能来源、旧API1 demo、采样空产物权限、异常outputs、预取消/截止点、慢存储或粘性清理等专项门禁；这些需由对应协议、应用测试或runtime另证。合成采样数值不证明真机CPU/PSS/RSS准确性、FPS、尾延迟或UI。

## 分发接入与证据界限

本批默认便携目录部署，不能计正式原TGZ或npx通过。正式原包应使用显式绝对路径和压缩字节SHA256，保留同一原TGZ，通过公开上传安装，逐普通成员核对原字节；部署者再在二进制旁写本次假ADB配置，生成清单与原成员不改。该接入另行冻结，禁止重新打包原包来制造通过。

npx应消费当前冻结宿主运行TGZ与同一正式插件TGZ，核npm实际shim/cache、CLI启动参数、HTTP/MCP与正常退出；registry发布单独记录。当前驱动不执行npx，不将便携部署转计分发证据。

假ADB和假Java只证明实际宿主、独立插件进程、公开协议、固定argv、直接PID、产物原字节及本批锁行为，不证明真机、真实ADB自动启动、共享daemon、派生树、设备动作回滚或性能。占位JAR不是可执行bundletool，合成APKS不证明真实设备匹配；假Java实际观测cwd和环境不证明真实JVM内部临时文件或bundletool派生ADB树。工具completed只表示退出意图，驱动另等PID不可见；不把该观察称为OS退出码。静态检查通过也不能替代debug/release两轮真实宿主服务报告。
