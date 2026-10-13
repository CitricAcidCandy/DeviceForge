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

媒体清理先处理有token证明的远端原PID/starttime，再收口本地ADB；外部取消仍可能先终止ADB，因此远端读取必须兼容进程退出竞争。同代stat状态Z或进程消失均表示不再运行，不读空cmdline、不杀僵尸；活态必须匹配固定dfv_scid才TERM。cmdline/TERM期间退出需复读stat，不以空字符串猜确认；PID复用、身份冲突或未知状态保留cleanup_failed。远端失败仍继续回收本地直接进程和精确forward，汇总清理资格。
