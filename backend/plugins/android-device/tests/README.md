# 安卓设备插件独立原帧验收

状态：FPS冻结版本曾通过Windows完整协议133/133；本批新增电气/温度协议8项，迁移9/12笔固定链与能力声明。当前源码共141项（含Windows文件锁清理失败1项），由主代理统一执行本轮门禁；旧133通过不覆盖本轮环境接线。详见 [性能采样迁出裁定](../../../docs/性能采样迁出最小实施裁定.md)。测试入口 `protocol.rs` 使用serde_json、sha2与标准库，无新增dev依赖；主代理执行测试时，通过PATH的rustc一次编译 `fixtures/adb.rs`，再复制至每个场景的独立工具目录。假工具识别固定ADB及APKS Java argv，不创建派生进程。

## 覆盖与固定期望

| 模块 | 最小断言 |
| --- | --- |
| normal | 原动作逐项执行；发现是公开设备数组；固定 argv/原 serial/trim output；合法 failed/error 包名；独立 Success；tap/swipe/keyevent/text，单引号、字面量 `%s`、enter 多笔与1024字节正界；Restricted环境；双清单十二贡献/十一能力与十一alias静态对照；APKS与性能实际调用由独立模块覆盖 |
| validation | 完整外部名拒绝；显式 provider null/两个字段；每层未知字段、非对象、null bool；宽 serial 原文与200 UTF-8字节，201及控制符反界；address/package/action 精确错误；空ArtifactContext合法、非空inputs先于配置拒绝；坏Request/Start零工具 |
| discovery | online/offline/unauthorized与未知 raw 原文及九项可用性；不把 provider能力写进设备项；空数组；重复/128与129整份边界；serial200、raw100、model200及越界；缺状态/控制符/型号重复/诊断/非法UTF-8整份失败，无部分结果 |
| output | 明确连接成功资格；包列表精确诊断；uninstall独立行而非子串；非零退出固定映射；INPUT-001两路非空/诊断和两路非法UTF-8；两路空白合法；失败不续下一段/enter；各路超过1MiB精确限额 |
| lifetime | Start0、延迟Start、同一次write中Start后cancel均零工具；运行中cancel/EOF/原总D到期；connect真实5s短点先于20s总D；三笔text共享原9s；错误cancel ID仍收口；每项匹配响应、无成功值、complete及同PID实际退出 |
| configuration | 逐层/重复字段、格式版本、ADB省略/null、相对目录/自由参数、目录/缺文件/非可执行工具、显式配置缺失/64KiB越界，全部精确错误且零工具 |
| artifact_validation | 安装唯一输入产物、严格 pointer/UUID/元数据、配置与路径前零副作用；截图空输入与输出授权；scratch_root 合法字段 |
| installation | 私有副本、固定 `-s serial install` argv、size/SHA256/显示名、64MiB边界、双流 UTF-8 与 Success 独立行、失败诊断及无输出声明 |
| screenshots | 固定 screencap argv、PNG 45 字节/IHDR/尺寸资格、64MiB stdout 与1MiB stderr、目标 create_new、授权目录和输出记录 |
| artifact_lifetime | 安装/截图工具取消、EOF、总期限、延迟 Start、私有文件与目录清理；Windows 锁定清理失败证据 |
| install_apks | 七项固定 Java argv、绝对 ADB、带空格 JAR 路径、私有原字节及源保留、cwd/TEMP/TMP/TMPDIR、禁继承变量存在性；空/普通/UTF-8 lossy 成功；九失败子串在两流均拒绝；非零退出/两流各1MiB；Java/JAR 配置、唯一pointer/ID/扩展名/size/SHA256、64MiB正边界；坏ZIP、缺空toc、缺APK、坏标识、重复、危险路径、真实CRC坏和10001成员均零工具；在途取消/EOF/原总期限和Start零预算/延迟Start |
| performance | 基础五笔加缺省游戏层查询和三环境命令的九笔ADB argv、原serial、毫秒时间戳与原始CPU/PSS/RSS、合法缺测FrameWindow、Restricted及零产物/私有文件；严格封套、首下划线包名、缺省上下文及空输出授权；未知工具/args/source/间隔与外部完整名先于配置拒绝；PID/stat/meminfo身份、汇总矛盾、溢出、核重复、进程重启均停止后续命令；八失败子串、lossy进程名、非零退出、各流1MiB边界；九个基础/可选阶段取消、meminfo EOF、原总期限、Start0/预取消/延迟Start及真实PID退出 |

| performance_environment | signed µA/µV与mV备用倍率、原device_id、当前HAL类别/名称/状态和宿主读取时点；无跨来源电流或Max charging current；charging/冲突unknown、缺TYPE/权限/冻结值/NaN/cache缺测、HAL电池抑制备用、总32项限额；三环境工具双流1MiB超限、原D、应用换代；逐工具取消由performance九阶段真实PID回归覆盖 |
| performance_fps | 有效窗口十二笔固定argv、同层双快照、不clear、真实新展示/去重/纳秒精度；无层/歧义/层切换/丢锚/未知文本/依赖失败缺测；两流超限、四可选阶段取消、原期限和FPS期间进程换代 |

旧动作默认手工 Request **始终带 Some 空 ArtifactContext**，有值 `output_directory` 不作产物配置或额外副作用。另有 None、空inputs/null输出目录正对照；非空inputs独立反例即使配置坏也应先报“该设备动作不接受输入产物”。安装独立提供唯一 `/input/artifact_id` 行、真实源文件与 SHA256；截图独立提供空 inputs 和实际授权输出根。因此真实宿主协议4上下文接缝直接进入本组，不能仅靠 artifacts:None 宣称 P1 已覆盖。是否通过以主代理实际结果为准。

性能是上述旧空上下文的明确特例：`support/performance.rs`手工将output_directory设为null，正向同时覆盖省略ArtifactContext；非空inputs及非空输出授权独立反例在坏配置前拒绝。不存在的scratch_root正向确认采样不创建资源目录，部署省略Java/JAR确认不借APKS依赖。该组不复用生产性能解析器，stat按真实内核字段位置手工构造；样本仅证明数值规则与调用顺序，不证明真机指标准确性。

SDK期望只按公开文档/冻结文案手工写JSON，不用生产parse/commands/discovery或私有hook生成自身期望。元数据测试直接读公开清单，但仅记静态对照，不算validator或宿主加载通过。原帧短名与HTTP/MCP外部完整ID分层；十一能力预算静态显式核普通30000、APK/APKS安装与卸载120000、性能10000，不用声明证明实际时长。

`support/apks.rs` 用独立手写 Stored ZIP 与 CRC32 生成外层样本，不引用生产归档 writer。样本 APK 仅带 ZIP 标识，符合外层验证合同，不虚构嵌套 APK 完整性。CRC 反例先修改内容再按真实字节计算授权 SHA256，因此失败来自成员 CRC 校验而非授权摘要。测试不扩写公共 ZIP/压缩库，2GiB/256MiB 分类有生产纯测试，完整压缩限额和文件工作内部取消/丢弃/panic仍由公共库及 Session 内部回归分别证明。

## 时点与实际进程证据

Request → 本次真实 Ready → Start → 工具原子ready → 取得本次OS PID等待句柄 → release/cancel/原D → 响应及直接进程退出。假ADB/Java不派生daemon或子进程；每笔独立 `call-NN` 记录原 argv 长度编码、PID、ready与正常退出标记。工具始终先hold，测试在PID仍活时开启观测，Windows持有等待句柄直到退出；退出不靠marker判断。插件直接PID/退出码由拥有该Child的客户端实际wait核对，单请求只有一个响应，正常处理必须exit0。

Start0/预取消不建立任何call目录；零启动不是仅检查stdout为空。延迟Start在Ready观测后真实等500ms，传入200ms预算，证明C0未被接收时重置。5s短点测试给20s总上下文，精确原帧错误为“插件或工具执行期限已到期”，不能把它写成宿主 Timeout；HTTP分类另验。

三笔text共9s，第一/第二笔在Ready观测+3s/+6s放行，第三笔保持hold。Ready观测只作真实C0上界，不读或改内部Instant。最终错误严格“插件执行期限已到期”；完成上界包含公开2s清理与观测余量，以抓逐笔刷新9s，不调整生产预算。此组用真实进程墙钟，不用暂停Tokio时间替代工具工作；12s原帧及其它看门狗仅防卡死，不提供吞吐/尾延迟结论。

每场景成功及失败都保留私有临时根，含部署配置、工具原件、原帧、argv、PID、插件退出记录和时间观测。失败兜底仅处理本次已知直接进程并留下fallback标记，不能据其通过清理断言；不删目录冒充清理。不保存继承环境值或真实凭据，Restricted仅记录固定禁继承变量的存在性。

APKS 另记录 Java 三项环境覆盖的存在性，确认 `JAVA_TOOL_OPTIONS`、`_JAVA_OPTIONS`、`JDK_JAVA_OPTIONS` 没有继承，不保存值。cwd 和 TEMP/TMP/TMPDIR 的观测只证明这些固定设置，不证明真实 JVM 所有内部临时文件都受其控制。

性能缺省路径依次放行九笔、有效游戏窗口十二笔真实直接客户端，每笔取得PID等待句柄并确认退出；任一阶段解析失败、取消或EOF后核对没有下一call目录。第三笔hold的总期限测试共用初始5秒，不为后续命令刷新；九个基础/可选阶段取消分别保持当前客户端在途。采样不声明产物、不建私有文件目录，但仍经Session的真实工具/worker租约与两秒清理点收口。该组不证明后台会话调度、owner撤销、宿主提交资格、CPU差分或device/read与write并行接缝。

## 本组不关闭的边界与主代理执行

APKS 尚未验证真实 Java/bundletool、真实设备匹配安装或派生 ADB 树。新设备准入、共用跨代写锁、旧 alias 同 Job 和整个原预算的宿主接缝由主代理服务门禁分别记录。

未验证真实ADB、默认共享server自动启动/保留、真实设备响应、系统设备端shell实际输入效果、设备状态回滚、server/派生树退出、真机、宿主统一发现发布门禁、锁/旧alias同Job、代际与服务在线安装/npx。`cleanup=complete`加本次客户端PID退出只覆盖声明的任务资源；不把假工具结果计真机或server回收。Windows 使用实际不允许删除的文件句柄构造 CleanupFailed，响应前确认 ADB 退出、错误优先于成功且私有目录保留；其它平台没有此用例。阻塞 worker 的 future drop/panic、重解析点/特殊文件、清理点 C 的每段共享以及到期与取消同时就绪的优先级由生产内部确定性测试另证；本组不以退出后的迟到 Cancel 推断优先级。

主代理冻结所有输入并接入workspace后可先执行 `cargo test -p apk-plugin-sdk` 与 `cargo test -p deviceforge-android-device-plugin --test protocol performance`，随后运行完整 `cargo test -p deviceforge-android-device-plugin` 与当前调度的fmt/Clippy/全门禁。生产单测与独立组分别登记，不借前组绿记录扩大本批性能实跑。服务窄驱动、release原包、npx及真机取样另行记录实际证据。
