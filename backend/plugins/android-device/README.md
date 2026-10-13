# 安卓离散设备插件

独立 `android-device` 通过公开设备 API3、协议4 和工具执行库接入宿主；生产不依赖宿主四层模块。首批部署目标为 Windows x64，源码及元数据落盘不代表编译、真实ADB或真机验收已通过。

## 名字与部署

十二贡献为 `discover`、`connect`、`disconnect`、`packages`、`app.start`、`app.stop`、`app.uninstall`、`input`、`app.install`、`app.install_apks`、`screenshot`、`performance.sample`。贡献和真实 Request.operation 仅接受短名；对外完整ID由宿主映射为 `plugin.android-device.<短名>`，误发完整名被拒绝。发现不算能力，其余十一项能力版本均为1。两个清单逐字节一致；便携包只包含清单、原生二进制和说明，配置不随公共包分发。

二进制旁部署文件为 `android-device.config.json`；唯一覆盖为部署参数 `--config <绝对路径>`。配置严格格式1且最多65536字节：

```json
{"format_version":1,"tools":{"adb":"adb"}}
```

tools或adb可省略；缺省旁置文件不存在等于空工具配置，显式文件不存在失败。没有ADB配置的执行返回确定依赖错误。ADB只接受合法绝对可执行路径或单一程序名；不接受自由参数或业务请求选择路径。受限环境仅继承PATH、SystemRoot、TEMP、TMP、HOME、USERPROFILE，不继承宿主令牌、APK_ADB或ADB server相关覆盖变量。

APKS 安装额外要求可选的 Java 和 bundletool 部署字段；其它动作不要求它们。Java 入口同样只接受绝对路径或单一程序名，bundletool 只接受 `java_jar` 和普通绝对 JAR 路径，不接受自由参数：

```json
{"format_version":1,"tools":{"adb":"adb","java":"java","bundletool":{"kind":"java_jar","jar":"G:/tools/bundletool.jar"}}}
```

可选`scratch_root`须为不含父路径的绝对目录；缺省或null采用系统临时根。目录存在且每段祖先为普通目录、无链接或重解析点；本次只在其下创建独占`deviceforge-android-device-*`目录。请求不能提供scratch_root，旧八贡献不创建新工作目录。

## 设备与结果

发现仅接收 `{}`，以 `devices -l` 返回公开 PluginDevice 数组，不自造宿主包装。最多128条；serial原文最多200个UTF-8字节、非全空白、无Unicode控制字符且不以连字符开头。动作保留原文，不收紧为ASCII标识。raw_state最多100字节，model可选且最多200字节；任一坏条目或重复标识使整次失败。

`device` 为online；`offline`、`unauthorized`分别归一；recovery、sideload、bootloader及其它合法原文归unknown并保留raw_state。只有online开放九项device能力；connect/disconnect是provider write，不放进每台设备的availability。截图、APK 与 APKS 安装均device/write，与其它同设备写动作共享宿主互斥。性能采样是device/read，复用提供者写屏障及当前代准入；它不进入device/write互斥，设备读与单台设备写允许并行，本批不增加全设备读写锁。

动作严格封套为 `{device_id,input}`：provider必须显式null，device必须合法serial，每层未知字段拒绝。地址为ASCII host:port，支持IPv4/DNS或方括号IPv6、端口1至65535。start/stop/uninstall包名必须是最多200字节的点分ASCII标识；start/stop比旧宽identifier收紧，这是兼容变化。

非input动作返回trim后的 `{output}`。packages只识别明确ADB诊断行，`package:com.failed.example`等合法包名不因子串被拒。connect必须明确connected to/already connected to；uninstall必须含独立Success行且无失败诊断。input 的可打印 ASCII 文本仍沿用单引号、空格到 `%s`、字面 `%s` 分段及 enter 最后按键规则，限 1024 个 UTF-8 字节并返回 `{device_id,action,dispatched:true}`。包含非 ASCII 的 text 限 4096 个 UTF-8 字节，要求配置固定 ADB Keyboard，先核验安装、启用和当前输入法，再以 Base64 广播；成功返回 `transport:"adb_keyboard_base64"` 与原始 `bytes`。两种结果都只表示工具接受，不证明界面已改变。错误只含固定中文，不回传工具诊断、输入文本或 Base64。

旧绑定见 `aliases.example.json`：仍为十一项，格式2的android.devices采用专用发现profile，其余十动作采用device_envelope；截图采用宿主真实产物投影，其余为值投影。性能采样没有新旧别名，旧八项性能会话操作由宿主继续管理。加载必须显式指定该绑定，目标缺失不回退内置。清单能力预算是唯一设备预算，不声明普通execution。旧 `android.app.install_apks` 精确映射 `app.install_apks@1`，value 投影 `wrapped:true`，继续保留旧入口 ASCII 设备 ID schema。

APK安装严格接收`{device_id,input:{artifact_id}}`，ID为36字符标准连字符UUID。授权输入恰好一行，field必须`/input/artifact_id`且ID完全一致；非安装动作只接受空inputs，合法Some空上下文可用。输入为.apk显示名、最多64MiB，普通路径与句柄无链接/重解析点，按真实size及完整SHA256流式核验并生成私有`input.apk`，ADB只读该copy。不增加完整Manifest、CRC或签名验证。固定argv为`-s serial install input.apk`，两路输出都须UTF-8、无失败文本且有独立Success行，返回`{artifact_id,output}`，私有路径替换显示filename。

APKS 安装使用相同严格封套、唯一授权、64 MiB 和 size/SHA256 资格，显示名须以大小写不敏感的 `.apks` 结尾，副本固定为私有 `input.apks`。公共 `android-package-core` 按 `ArchiveProfile::Structure` 与 Default APKS 规则核验：最多 10000 成员，结构声明最多 2 GiB，APKS 实际展开最多 256 MiB，非空 `toc.pb`、至少一个带 ZIP 标识的 APK、无重复成员、完整长度与 CRC。它不验证嵌套 APK 的完整 Manifest 或签名，设备匹配由 bundletool 完成。

Java 固定 argv 为 `-Xmx256m -jar <JAR> install-apks --apks=<私有input.apks> --device-id=<serial> --adb=<绝对ADB文件>`。ADB 单程序名按 PATH 解析，Windows 无扩展名时另尝试 `.exe`；普通文件与祖先目录资格仍须通过。Java 的 cwd 和 TEMP/TMP/TMPDIR 均为本次私有目录，两路输出各最多 1 MiB。保留旧 APKS 成功语义：直接工具零退出，UTF-8 lossy 合并两路后不含 `failure/failed/error/unable/cannot/offline/unauthorized/no devices/incompatible` 任一子串便成功，空输出合法，不要求独立 Success 行。结果精确为 `{artifact_id,device_id,installed:true}`，不返回原诊断或新产物。

迁出宿主后的 APKS 要求提供者当前代已观测、在线且精确能力可用；旧生产入口只验证 ID 后直接调用工具。新的 `(provider_id,local_id)` 跨代写锁与 APK、截图、输入和卸载等共用，替代旧 APKS 单实例内部锁；锁等待与全部阶段共用原预算，替代旧安装端口内部重新计 120 秒。这些属于明确兼容变化。

截图严格接收`{device_id,input:{}}`，必须有宿主输出授权。固定argv为`-s serial exec-out screencap -p`，先写私有`screenshot.png`，stdout最多64MiB、stderr最多1MiB。真实文件排空后执行现有最低PNG资格：至少45字节、PNG签名、长度13与IHDR、非零宽高；不做完整CRC/图像解码。再沿原期限复制到授权根的固定新文件，不覆盖原文件。runtime value为null，唯一ArtifactOutput只含`screenshot.png`文件名，宿主生成实体；旧android.screenshot采用artifact投影。

## 单次性能采样

`performance.sample` 严格接收 `{device_id,input:{package}}`，不接受工具路径、自由参数、来源或采样间隔。性能目标保持旧规则：最多200字节、至少两个点分ASCII段，每段首字符为字母或下划线，其余为字母、数字或下划线；这项规则独立于普通应用动作的包名校验。

清单性能声明为API2，协议4、设备API3，精确引用本插件 `performance.sample@1` 的device/read能力，预算10000毫秒，`fps=false`。插件其它动作的产物声明继续有效，采样的有效权限必须为空：`inputs=[]`、`output_directory=null`，也接受缺省ArtifactContext；非空输入或输出授权在读取部署配置前拒绝。采样不创建私有目录或文件，不返回新产物，不依赖Java或bundletool。

同一次调用依序执行五笔固定ADB命令，serial保留原文，package只来自严格业务字段：

1. `-s serial shell -T pidof -s package`
2. `-s serial shell -T cat /proc/pid/stat`
3. `-s serial shell -T dumpsys meminfo -s pid`
4. `-s serial shell -T cat /proc/pid/stat`
5. `-s serial shell -T cat /proc/stat`

每笔直接客户端都复用Restricted环境、两流各1MiB、原截止点与真实退出确认。保留旧探针的UTF-8 lossy双流合并，以及 `permission denied`、`permission denial`、`no such file`、`error:`、`exception`、`not found`、`device offline`、`unauthorized` 八个失败子串；不回传原诊断。解析要求唯一非零u32 PID、stat的原始CPU计数与starttime、匹配PID的TOTAL PSS及可选RSS、无重复且1–4096个逻辑核；计数累计检查溢出。第四笔starttime变化时立即失败，不执行第五笔或返回部分样本。

成功只返回既有原始样本：采完后的毫秒时间戳、PID、进程start_ticks/CPU ticks、系统CPU ticks、逻辑核数、PSS与可选RSS，不填FrameWindow或FPS。CPU百分比差分、会话调度和历史仍由宿主计算与保存，直接sample调用不建立会话。纯解析占既有单槽受限worker，共用Session排空及清理收口，不新增进程框架或逐阶段预算。

## 期限和清理资格

发现与七项普通能力总30000毫秒，app.uninstall、app.install 与 app.install_apks 总120000毫秒，performance.sample总10000毫秒；排队、握手、配置、准备副本、归档校验、工具、输出复制及结果处理共用宿主原D及协议4本地D_L。connect工具短点为min(D_L,启动前时间+5000ms)，其余直接同D_L，多笔input及性能五命令不刷新期限。短点先到且总期限未到时，接受既有宿主字符串失败映射dependency_failed。每笔工具、复制分块及成功交付前复核上下文。

直接客户端进程由公开capture_with_lease/capture_to_file_with_lease管理，真实PID退出才释放工具租约；未确认清理为粘性cleanup=failed。三项产物动作和性能采样每调用最多一个活动阻塞闭包，闭包持许可/lease至真实返回；APKS 公共校验、性能逐行解析沿原截止点和只读取消回调，采样不建立目录。截图文件由独占任务拥有，捕获后flush和into_std等待内部文件I/O排空并关闭真实句柄，再释放文件lease。取消或丢弃等待只通知取消，不提前删除仍在使用的目录。

首次观察取消/到期或进入finish固定同次最多两秒清理点；业务到期后允许清理，不允许继续业务或阶段续期。目录无自动删除Drop；真实工作排空、租约归还及实际remove_dir_all成功/目录不存在全部成立才cleanup=complete。prepare失败也走同收口，任何未确认为failed并保留目录。SDK输出根归宿主，只在失败时撤除本次明确独占创建的固定文件，不删除根或原有同名文件。

标准ADB可自动启动默认共享server，server及持久连接归部署者；取消/卸载不kill-server、不断开其它用户连接、不回滚设备状态。cleanup=complete只确认本次客户端、私有文件/目录声明范围，不证明daemon、派生树或设备事务恢复。

APKS 的确认范围仅为本次直接 Java 进程、文件与目录。bundletool 可派生 ADB 客户端并使用共享 server；Java 退出不证明派生进程树退出，也不回滚部分安装。

## 交付边界

`app.install_apks@1`的嵌套输入新增可选modules，缺省保持原安装argv及结果；不接提取instant或请求自选设备规格。模块规则归公共核心apks模块，真实设备匹配仍归bundletool。本批新增4项所属回归尚未运行，详见[APKS高级匹配插件实施裁定](../../docs/APKS高级匹配插件实施裁定.md)。

本批性能声明、采样源码、纯解析和独立协议/假ADB/PID测试已实施，编写者未运行Cargo、格式化、构建或服务；当前十二贡献版本尚无本批运行通过证据。前批APKS十一贡献版本已由主代理单独冻结元数据并完成测试与构建，详见 [性能采样迁出裁定](../../docs/性能采样迁出最小实施裁定.md)，该证据不转计性能改动。宿主装配、统一门禁与debug/release/npx由主代理串行验证。真实Java/bundletool/ADB、默认共享server、真机设备匹配、CPU/PSS/RSS数值及暂停/停止/卸载、派生树、其它系统、真实FPS和常驻采集仍需独立验收。
