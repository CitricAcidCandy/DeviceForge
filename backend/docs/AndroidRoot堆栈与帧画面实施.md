# Android Root堆栈与采样画面实施裁定

更新时间：2026-10-13。用户授权当前继续Android性能采集、Root堆栈及画面关联；切换其他业务前须询问用户。

## 架构门禁

模式 architecture-first；采用Hybrid：先冻结公开业务合同，再实现真实采集与有界解析，独立服务验证取消/身份/产物。影响设备插件、公共任务/产物消费和所属文档，不新增宿主平台分支。对比独立android-profile提供者与扩展现android-device：选择现提供者新增能力，复用同设备稳定写锁；独立提供者锁不能天然协调物理同机，暂不采用。

| 模块 | 责任与输入输出 | 副作用与边界 |
| --- | --- | --- |
| android-device operations/manifest/discovery | stack.probe、profile.record严格封套与设备能力 | 薄接线；两能力device scope/write，录制120000ms总预算 |
| profile/root、capture、session | Root资格、拥有的simpleperf远端进程、计数与采样画面 | 固定argv/固定受检脚本；不setenforce、不改变系统安全配置、不控制游戏 |
| profile/report | SIMPLEPERF protobuf解析、线程/库/函数/叶到根链、丢样 | 纯规则与有界检查；不伪造符号包资格/源码行 |
| profile/publication | 录制索引、JSONL与PNG归档发布 | 独占授权目录；失败撤销自有文件，不删除其他文件 |
| frontend features/android-profile | 公开设备调用任务与产物完整性、索引和关联消费 | 复用共享任务/设备SDK；具体页面不做 |

## 第一版固定合同

设备能力stack.probe v1、profile.record v1；实际短贡献同名，外部操作plugin.android-device.stack.probe、plugin.android-device.profile.record。输入仍是公开设备封套 {device_id,input}。

stack.probe业务输入 {package}。结果 {format_version:1,device_id,package,root_access:none|adbd_root|su,simpleperf_available,clock:"boottime",supported,reason}；未取得UID0/工具不可用只说明实际资格，不自动提权。

profile.record业务输入 {package,duration_ms,interval_ms,capture_frames}；duration_ms 1000..15000，interval_ms 1000..15000且不大于duration_ms，capture_frames默认true。Root方式与simpleperf入口由部署配置决定，支持auto、adbd_root及固定su_c部署策略；无Root仍采普通指标及画面，不接收业务命令/路径。

录制使用simpleperf record -p PID -e cpu-clock -f 99 -g --clockid boottime --duration 秒数 -o 自有远端文件。report-sample --protobuf --show-callchain生成报告；自有远端进程PID/starttime与目标PID/starttime/UID均需复核。单录制一个受控远端监督单元，每阶段最多一个simpleperf；监督器和simpleperf原PID/starttime及退出回执均须核验，有原绝对期限；取消/退出不仅回收ADB客户端，还要确认远端原PID退出和自有目录清理，否则cleanup_failed。文件/解析不阻塞异步调度线程。

profile.record结果 {format_version:1,device_id,package,pid,process_start_ticks:string,clock:"boottime",frame_kind:"scrcpy_sampled_frame",display_frame_complete:false,sample_count,stack_sample_count,reported_sample_count:string,lost_count:string,frame_count,root_access,stack_status,stack_reason,frame_status,frame_reason,index_filename:"profile-index.json",archive_filename:"profile.zip"}。详细数据放产物，响应不复制大数组。

索引profile-index.json {format_version:1,device_id,package,pid,process_start_ticks:string,clock:"boottime",frame_kind:"scrcpy_sampled_frame",display_frame_complete:false,samples:[{index,begin_ns:string,end_ns:string,target_ns:string,metrics:原PerformanceSample,frame: null|{index,filename,begin_ns:string,end_ns:string},stack_sample_indices:number[]}],stack_sample_count,reported_sample_count:string,lost_count:string,root_access,stack_status,stack_reason,frame_status,frame_reason,symbolication:"reported_symbols_only"}。每指标样本前后读取/proc/uptime，时间区间含其10ms文本量化误差；不把区间当精确瞬间。样本最多16、栈索引最多4096/样本，超过不截断为完整关联，须明确限制失败。关联只有堆栈时间在样本区间内才写indices，区间外保持未关联；不按宿主墙钟猜配。截图属于采样时的设备画面，不能宣称是目标游戏独占窗口或实际每个显示帧；目标PID换代整录制失败。

归档profile.zip使用Stored，包含profile-index.json、stacks.jsonl和frames/000000.png等采样画面；仅实际成功堆栈录制时包含非空perf.bin，无Root省略perf.bin并保留空stacks.jsonl。原trace及报告各64MiB上限；栈样本最多100000，链深256，表/文本有界，解析取消检查；JSONL最多32MiB，ZIP不压缩膨胀的raw录制结果，整体64MiB，不写任意产物格式。索引最多1MiB，宿主现有JSON/ZIP准入复用。

SIMPLEPERF格式：magic10字节SIMPLEPERF，u16le version1，u32le记录长度+Record protobuf，最后u32le零且无尾随字节。官方schema见system/extras simpleperf/cmd_report_sample.proto，Record=Sample1/LostSituation2/File3/Thread4/MetaInfo5/ContextSwitch6。样本可能先于符号表且未排序，解析后按时间稳定排序；未知symbol=-1保留库/地址；调用链叶到根。boottime由本次固定录制参数证明，不沿用官方默认monotonic注释猜测。

## 验证与缺口

实施真实probe/record、报告解析、持续视频抽帧及对应索引，前端消费并行；必要功能门禁和独立服务不等待整批开发。用户已选择采样点画面模式，设备可为真机或模拟器，su权限需探测且无Root兼容；完整编码视频帧与实际显示帧不属于本批承诺。当前不进行性能专项/压测。正式真机、OEM、符号包和完整显示帧覆盖独立验收，不能由合成工具通过替代。

## 用户确认与权限增量

2026-10-13用户明确选择每个指标采样点对应当时画面；设备可是真机或模拟器，Root方式为su，必须兼容无Root设备。部署Root策略支持auto/adbd_root/su_c，业务不接受shell命令；先以固定id -u核UID0，按策略尝试固定su -c路径。无Root或拒绝授权时profile.record仍采集普通指标与PNG，返回stack_status=unavailable和固定stack_reason；不伪造perf.bin或堆栈。Result/index增root_access=none|adbd_root|su、stack_status=captured|unavailable、stack_reason=null|非空；unavailable堆栈计数/丢样为0且全部indices为空。su提示/超时有界，不能阻止普通指标无限期等待。

无符号包仅保留报告可用库/函数/地址。REA为MCP服务，需要Agent操作插件连接；用户要求仅列后续计划，本次不接入、不实施。后续方向仍由用户决定。

## scrcpy持续视频画面增量

用户要求优先scrcpy，避免每次screencap启动、捕获、编码和传输延时。本批调整为持续启动固定版本scrcpy-server3.3.1，audio/control=false，只接收H264和原presentationTimeUs。Rust持续保存有限H264字节与每帧PTS/序号，不在每个指标采样点启动截图。录制结束后按指标设备采集区间中点选择最近视频帧，受检FFprobe确认无B帧、解码帧数与视频记录一致，再用固定FFmpeg参数抽取对应PNG。尚未完成真机速度/精度验证，不承诺零延时；静态画面重复帧不等于手机实际显示每帧。

媒体模块profile/media.rs及media/**负责独立scrcpy目录/forward/server/socket、时钟helper、frame选取和解码。Root remote模块保持simpleperf监督器所有权。两者各自记录原PID/starttime；正常收口沿原deadline，取消/错误同一次cleanup_point，远端/直接进程/forward不确认则cleanup_failed。设备写锁覆盖整个profile.record。

部署profile平铺可选字段 {scrcpy_server:绝对路径,server_version:"3.3.1",clock_helper:绝对DEX/JAR路径,ffmpeg:固定入口,ffprobe:固定入口}；当前采集固定640px、30fps、2Mbps；完整app_process启动参数少于255字符，control=false时按官方默认省略power_on参数；业务不能选择程序/脚本。无配置或明确不支持画面时保留指标，frame_status=unavailable及固定frame_reason；capture_frames=false为disabled。media累计32MiB、frame记录≤2000、单包4MiB、输出归档64MiB、PNG最多16张和每张4MiB。取消清理不因普通unsupported被吞掉。

设备时钟helper一次读取System.nanoTime→elapsedRealtimeNanos→System.nanoTime，输出monotonic/boottime对应区间；前后两个校时锚限制误差和offset变化。原媒体PTS与monotonic锚实际范围必须符合，boottime offset变动或落界外保持无关联，不凭MediaCodec字段默认推测。helper由本项目最小Java入口生成，纯读时钟，不修改游戏。各采样窗口由/proc/uptime原百分秒文本给10ms量化边界；target_ns为begin/end中点。

新frame_kind=scrcpy_sampled_frame。frame既有字段保留，增 {source:"scrcpy",epoch:1,video_frame_index:u32,pts_us:string,device_time_ns:string,selection_delta_ns:有符号十进制字符串,clock_error_ns:string}。frame.begin_ns/end_ns为选中视频帧映射时间的误差区间，不伪装指标采集瞬间；距离target_ns超过250ms不补过期画面。index/result增frame_status=captured|unavailable|disabled、frame_reason=null|固定字符串；frame_status与stack_status相互独立。旧sampled_screenshot仅前端兼容保留，不作为当前生产主采集路线。下载归档能够取得每样本对应PNG并消费时间差。

必要验证：命令/字节/PTS/时钟不同域、无B帧及帧数量、过期拒配、取消远端原进程退出及forward、ZIP原字节；真实设备画面/延时与FPS精度独立，性能专项仍待全部业务完成。

## 录制派生指标增量

实施模式architecture-first，复用现有采集数据，在每个samples条目增加可选derived对象，旧索引缺省兼容；metrics保留原PerformanceSample累计计数语义。派生纯规则属于Android独立插件，不引用宿主domain、不增加宿主平台分支，前端只校验与消费。

derived第一版固定为{api_version:1,cpu_share_percent:number|null,cpu_core_percent:number|null,cpu_reason:string|null,fps:number|null,fps_reason:string|null,battery_net_power_mw:number|null,battery_reason:string|null}。CPU两百分比同有值或同缺测；有值时reason=null，缺测必须带非空中文原因。首个采样没有差分基线时不可计算，不能报告虚假零。相邻PID、启动计数与逻辑核数相同，captured_at递增，计数无回退且系统差分大于0、进程差分不大于系统差分才计算；share=进程差分/系统差分×100，是整机CPU容量占比；core=share×逻辑核数，是单核归一化占比，可大于100。两者只代表目标主进程。

FPS仅从通过归属资格的frame_window派生，frames×1000/duration_ms；缺窗口保持null与原因，真实零帧保持0。电气值保留设备来源、权限、原单位和极性，净电池功率复用公开SDK的极性规则，单位mW；正为充电、负为放电。该值归属整台设备的电池侧，不代表游戏独占消耗，也不等于外部供电时整机负载功率。设备缺电压/电流或极性未知时保持null，不推测数值。

职责：profile/derived负责纯派生及固定原因；profile/capture负责本录制相邻基线；models只承载可选字段；frontend/features/android-profile/derived负责版本、范围和原数据资格校验。采用Hybrid，先核首样/真实零/回退与核数变化/功率正负，再执行录制归档及前端联合消费。底层CPU/PSS部分失败合同与所有逐传感器缺测原因仍需独立增量，不用本对象冒充已覆盖。

## 设备就绪与退出竞争修补

三星Android11功能诊断：239字节的完整app_process参数、固定2Mbps与短nice-name已收到h264配置和真实编码帧，原编码器栈损坏未复现；完整采样归档仍需修后真机复验。ADB forward的TCP连接成功不等于远端服务就绪：首次连接可直接EOF，随后相同会话重连才取得协议头。连接预算统一min(原总截止点,入口+5秒)，配置头完整且h264/尺寸合法才交给reader，reader不重复读取；早EOF受同一预算重试，取消与总超时保留原错误语义。

媒体清理先处理有token证明的远端原PID/starttime，再收口本地ADB；外部取消仍可能先终止ADB，因此远端读取必须兼容进程退出竞争。同代stat状态Z或进程消失均表示不再运行，不读空cmdline、不杀僵尸；活态必须匹配固定会话nice-name（最终版本为8位scid）才TERM。cmdline/TERM期间退出需复读stat，不以空字符串猜确认；PID复用、身份冲突或未知状态保留cleanup_failed。远端失败仍继续回收本地直接进程和精确forward，汇总清理资格。

## 编码器颜色元数据兼容

三星默认H264错误标记YCgCo：按该标记解码虽可生成PNG但视觉审核存在严重偏色，未取得颜色资格，不能计完成。最终通过scrcpy官方video_codec_options=color-standard:int=1在MediaCodec.configure前明确请求Android COLOR_STANDARD_BT709，真机原H264随后输出bt709/bt709，普通FFmpeg抽帧可成功，不强改解码矩阵。

完整固定启动参数254个ASCII字符，低于三星255字符崩溃边界。nice-name只用本会话8位scid；远端所有权仍由64个十六进制字符的随机token及原PID/starttime验证。保留默认dummy字节，连接就绪固定读13字节（dummy0加h264/width/height），传给reader的配置头仍为12字节。固定640px/30fps/2Mbps，control/audio=false；指令不亮屏/不注入游戏。颜色正确性需子代审图，非同时参考不能证明精密色准。

## 2026-10-13 最终三星游戏画面功能验收

最终BT709冻结插件2531842a…使用真实SM_G991U Android11采集com.ChillyRoom.DungeonShooter，报告和独立验收位于artifacts/android-profile-device-bt709-a9a45598-c562-4ef2-87ea-a182c7d5477d。2个指标样本均取得scrcpy PNG，设备时间选帧差分别-16.177405ms/+12.336595ms；这只是本次时钟映射结果，不承诺所有OEM的真实20ms精度。指标PSS/RSS、CPU差分、FPS和CPU/电池/皮肤温度返回；首样CPU缺基线保留null。本次FPS窗口为16帧/185ms，派生86.486…，只是观察值，未校准精度。

视觉子代审核两张正式图：第一张为地牢战斗，第二张为标题菜单，未见此前全局通道错色、灰阶、黑屏或比例异常；场景不同且参考图较早，不证明精密色准或完整显示每帧。ZIP344388字节及索引5734字节大小/SHA一致；实际前端43份冻结源码经Node公开消费入口通过，索引和PNG原字节一致，不等于产品UI/真实浏览器完成。

三星无Root，stack unavailable且0栈，指标与画面正常；本机电池观测不足，净电池功率null。真实Root栈、完整符号化、游戏独占功耗及OEM精度仍独立待验。驱动/前端消费进程及宿主均exit0，端口58546释放，forward为空，本次scrcpy3.3.1与时钟助手无存活；用户已有scrcpy5.0.1进程保留。首失败目录1ba01fea…为主代理验证清单漏executable导致载入400，补部署入口后成功，生产二进制未变；首失败原件不删除。

## 完整workspace重建debug包独立资格

完整workspace1732通过后的重建host9f7cfe9b…/plugin5923a5e1…已冻结于artifacts/android-profile-workspace-debug-frozen-4b40ba34-2d12-4ae7-bd5c-2b310380c29f，并独立通过正常Root/无Root、生命周期与转发归属三批，合计12检查/6任务/260工具/6下载。实际前端43份源码归档消费、原OS退出/取消、下载大小/SHA、端口释放均核验。service-acceptance.json及artifacts/android-profile-workspace-golden-8fb2f364-7162-458f-a9ee-93ab89498931/final-workspace-media-batches.json为新字节资格。

此前三星真机色彩属于hosteefc4e…/plugin2531842a…；本次新字节三批使用合成ADB和本机TCP，未亮屏/采手机，不把旧包真机成绩外推。源清单和新旧冻结清单22929字节/SHA403216f0…一致，既有记录不能证明二进制差异原因，保持unknown。正式分发、Root真机及游戏独占功耗/OEM精度继续待验，性能专项仍延后。

## 2026-10-13 三星电池服务备份节兼容

手机保持DOZE_SUSPEND息屏时只读检查：标准电池sysfs节点被ADB shell拒绝读取，dumpsys battery仍有当前电压、状态、供电与温度，但尾部BatteryInfoBackUp独立标题使原解析整份缺测。原件保存于artifacts/android-power-readonly-166736c4-8c12-485a-ab6b-fb2a3334a838；本次不唤醒、不切游戏、不使用su，也不修改电池模拟状态。

私有解析仅允许主标题后一次精确BatteryInfoBackUp作为当前字段采集结束标记，备份值不能补齐当前缺值；后文仍扫描上下文、512行限额、重复主标题和全区已知字段重复。其他无冒号行、UPDATES STOPPED、无效编码等原拒绝资格保留。新增4项解析与2项映射回归，公开SDK、生成类型与前端代码不变。

该修复恢复标准电压、温度、充电与供电状态；三星current now厂商字段没有已核单位与极性，不按标准微安解释，最大充电电流也不作为实测电流。sysfs无读取权限时current_ua仍为null、极性unknown、净电池功率null，不能宣称已取得游戏功耗。当前修后门禁正在执行，终态以本次原句柄报告及根交接为准；旧冻结包真机画面证据不转计修后的二进制。

本轮终态：修后架构27模块/6规则、fmt、全workspace Clippy、完整workspace测试与debug build全0；测试助理核定顶层136组/1738通过/0失败/0忽略/0筛除，新增6项逐名通过，AI助手子进程的1通过/32筛除仅为嵌套输出。1115份后端维护输入在修后门禁及两模式功能检查前后大小/SHA一致。普通runtime与--performance-plugin均通过，后者是模拟工具功能模式，不是性能专项。首次Clippy因新增回归Cell不满足Sync失败，改AtomicUsize后通过；失败原件保留。

证据：artifacts/android-power-readonly-166736c4-8c12-485a-ab6b-fb2a3334a838内保存只读设备原件、源码before、门禁输入与gates-report.json、runtime-report.json、frozen-debug及screen-final.json。修后host71220b4b…/plugin46b89f58…/清单403216f0…在功能运行后冻结并复核，没有保存运行前二进制摘要，因此不宣称两模式运行前后字节一致，也不转计此前253或592包的真机与媒体资格。最后KEYCODE_SLEEP223后DOZE_SUSPEND、非交互，自有运行进程无活项；未亮屏或重采游戏。

## 2026-10-13 环境观测权限来源修正裁定

模式plan-and-build，影响私有采集整合与纯映射两层。目标是让电池及温度的access准确反映本次已有Root读取路径；公开输入、SDK字段、单位、功率算法、持久化结构与读取命令不变。record_profile已有qualification.access到Session.profile_root赋值，普通sample创建的Session无此资格；performance_read在已有Root时使用固定root::argv，否则使用普通ADB shell。当前映射恒写AdbShell，需修正此真实元数据缺陷，不新增Root探测或su请求。

对比把SDK访问枚举另传给映射函数与让私有EnvironmentObservation携带ReadAccess。选择后者：访问来源随同原始观测传递，默认AdbShell，纯私有model不引用SDK；映射显式转换到已有SDK RootShell/AdbShell，避免额外隐式上下文。

| 落点 | 输入输出与职责 | 副作用边界 |
| --- | --- | --- |
| rules/environment/model.rs、environment.rs | 私有ReadAccess枚举及原始观测access，默认普通读取；仅私有导出 | 纯数据，无SDK/进程/公开版本变更 |
| session/performance/environment.rs | 从已确认profile_root形成访问来源，随电池/服务/HAL原值交出 | 复用原读取和截止点，不额外探测权限 |
| rules/environment/mapping.rs | 单一纯映射把私有访问来源映入电池、HAL温度和电池温度回退 | 不改来源名称、数值、单位、缺测或功率规则 |
| rules/environment/tests.rs、mapping/tests.rs | 普通默认、Root sysfs、Root服务回退、Root温度的资格回归 | 固定代表数据，无实际Root设备声明 |

当前解析/采集/映射已分文件，无混合职责，不再拆公共模块。采用Hybrid：先核两种权限来源及各回退的纯映射，然后必要后端门禁、现有Root合成功能采样与三星原件无Root重放；主代理统一生成和构建。测试助手独占OEM重放驱动，前端独占两条降级消费回归，后端独占上述六私有文件，主代理负责文档与契约审核。Root真机、匹配符号、OEM精度和游戏独占功耗仍属实际设备缺口；手机保持息屏，不为本修复唤醒。

## 2026-10-13 权限来源修正已验证与取消缺陷回流

环境访问来源修后后端顶层136组/1741通过，架构27模块、Node规则6、fmt、全workspace Clippy、完整测试、debug构建及runtime两功能模式全部退出0；1115份维护输入前后大小/SHA一致。首次全量在既有OS ready JSON create/write竞态失败，原件保留；测试读取仅在原10秒截止内对serde EOF重读，完整坏语法仍拒绝，scoped12项与新增oracle通过。前端两条dumpsys降级消费回归及完整68文件/617项、严格类型和208模块构建通过，生成字节未变化。证据根为artifacts/android-observation-access-a4832cd8-707f-4cec-a064-315b1ab7bb43。

修后冻结debug host a3b1be81…/plugin c17a5e57…/manifest403216f0…的Root访问通道独立实服通过，报告artifacts/android-root-access-debug-76c3ea7b-4a9b-4614-8be1-f061088a3968/report.json：5检查/2Job/42工具，真实Session、HTTP/MCP、ZIP原字节及43模块实际前端归档消费成立；UID0但Simpleperf不可用仍报告root_shell，普通无Root为adb_shell，未执行su。固定4V/-500000µA得到整机净电池功率-2000mW。测试助理独立核原OS句柄/父插件身份与退出、74输入前后一致、宿主64224 graceful exit0及49459端口释放。它是合成工具功能资格，不替代真实Root设备、媒体或产品UI。

同冻结包的三星原stdout重放先通过3887mV/34.1℃/Charging/External/电流缺测/净功率null及HTTP/MCP/实际前端消费，但stop后卸载返回409 cleanup_failed，整体首轮失败原件artifacts/android-device-observation-oem-debug-9ea3a9b4-dc53-41a7-a9ca-36c302718af8保留。第一采样9工具及原父插件均零退出，第二调用未产生ADB即取消；日志高度符合通用Ready/Start取消缺口，但缺第二调用握手原字节，不断言已捕获确切窗口。修复裁定已追加插件执行上下文第四版裁定，正在修改通用握手取消收口；不改电池业务、卸载断言或驱动等待绕行。

本轮未唤醒手机；再次KEYCODE_SLEEP223后DOZE_SUSPEND且mHalInteractiveModeEnabled=false，原件screen-resume.json。当前新取消修复尚未门禁/冻包复验，以上结果仅对应各自明确字节。

本轮启动取消修复后新包OEM与Root功能重放均通过，准确终态/原件及首次失败见[第四版取消裁定](插件执行上下文第四版裁定.md)本批终态。三星再次KEYCODE_SLEEP223后DOZE_SUSPEND、非交互，screen-final.json在startup-cleanup；本轮全部自有进程终态。旧三星游戏画面仅属于原253包，不能转计新583包。前端340维护输入delta0、617/68与生成证据复用，无新增浏览器或产品UI。

本批最终独立复核无阻断：136组1749通过/0失败/忽略/筛除，8新增逐名通过，1115输入delta0；新OEM/Root两批51原OS工具及父插件退出、175去重身份、实际前端样本/ZIP消费、原stdout与旧OEM失败保留已核。独立报告startup-cleanup/independent-final-audit.json；本轮记录、todo与根交接已同步。


## 2026-10-14 模拟器 su 传输兼容验证

Android 9 模拟器固定监督脚本实测返回 ready/clean 的 CRLF 回执，原严格 LF 判定产生假清理失败。文本监督通道仅将完整 CRLF 对归一为 LF，保留额外内容、独立回车、诊断、限额和所有权/期限检查，清理回执精确接受 LF/CRLF；二进制下载不做换行替换。新增回归及插件库162项通过，修后真实录制仍待完成。

另用固定二进制 printf 诊断发现 shell -T 路径会把 00 0a 0d ff 转成 00 0d 0a 0d ff；因此该设备原二进制下载尚未取得资格，正在核验 exec-out 原始输出通道，不能通过删 CR 修复 perf 原字节。原件位于 artifacts/android-root-emulator-live-UcCxJn，未把工具帮助或文本回执通过计为真实调用链完成。
