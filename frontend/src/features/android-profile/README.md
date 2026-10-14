# Android Root 堆栈与采样画面消费

本模块采用 plan-and-build，消费冻结的 stack.probe v1 与 profile.record v1，不创建产品页面，也不改变宿主 SDK 或 runtime。通过公开 host.devices.invoke 携带完整设备引用；宿主负责转换为 {device_id,input} 封套。外部任务操作为 plugin.android-device.stack.probe 与 plugin.android-device.profile.record。

## 职责

- types/rules：独立插件业务模型、输入和资源边界；任务、产物及设备观测引用共享公开契约。
- observations/metrics：原 PerformanceSample 与设备观测严格校验，不补 sequence、CPU 百分比或 FPS。
- derived：可选第一版派生结果的范围、缺测原因、CPU 基线资格、FPS 窗口和净电池功率一致性校验。
- results/index-results：unknown 结果、产物名单、进程身份及录制索引校验。
- index：公开设备调用与共享 Job runner 的薄适配；恢复只查询原任务，取消等待不自动取消或重提服务器任务。
- frame-results：兼容旧采样截图，严格校验 scrcpy 帧的原 PTS、设备时间映射、误差区间与选择时差。
- artifacts：按已发布大小与 SHA-256 验证原字节，严格 UTF-8 解析索引；索引下载日志与提交/查询日志分别保留。
- archive/zip/png/crc：有界 Stored ZIP 解析、目录/局部记录一致性、CRC32、PNG 容器与尺寸，联合交付同一归档的索引、堆栈、PNG 和 trace。
- stacks：32 MiB JSONL、512 KiB 单行、100000 样本及 256 层链上限，保留 zero-based 行号、叶到根链、未知符号与回栈错误，不重新排序。
- timeline：boottime 纳秒十进制字符串通过 BigInt 比较；按样本区间验证已报告 indices，并单独给出截图区间内堆栈、样本未关联及画面未关联堆栈。

## 消费边界

索引最大 1 MiB、16 个采样点，每点最多 4096 个堆栈索引；ZIP 最大 64 MiB。downloadProfileArchive 返回经过完整性验证的 ZIP 原字节；downloadAndOpenProfileArchive 一步完成原字节验证、Stored 解包、嵌入索引与独立发布索引的大小/SHA 一致性、堆栈关联及 PNG 消费。openProfileArchive 可处理调用者已取得的同一录制原字节。frames 返回带原时间引用与尺寸的 image/png Blob，供调用方展示或保存；模块不创建 Blob URL。captured 要求非空 perf.bin，unavailable 不允许伪造 trace。

旧 sampled_screenshot 是采样区间的设备画面，display_frame_complete 固定 false；不证明游戏独占窗口，也不代表每一个显示帧。截图区间与指标采样区间分别保留，不通过宿主墙钟猜配，不将低频指标插值成逐帧观测。reported_symbols_only 仅表示报告已有符号，不证明外部符号包与目标构建匹配，不补源码行或符号资格。时间关联不表示因果。

本批冻结写集后由主代理运行定点测试、严格类型检查和集成门禁；源码实现不等同真机、Root/OEM、符号包或实际每帧准确性验收。

## Root 与设备兼容

Root 访问方式明确为 none、adbd_root 或 su；probe.supported 只表示堆栈采集资格。没有 Root 或 simpleperf 时仍消费成功的指标与采样截图，stack_status 为 unavailable，保留非空 stack_reason；栈数量、lost_count 与关联索引须全部为零。captured 才表示本次采到了栈报告，原因须为空。Root 方法由服务部署选择，前端不发送 su 命令或自行提权。

真机和模拟器都通过相同公开设备能力消费；权限、厂商工具及实际测量准确性须分别验证，本模块不以模拟器或合成工具通过替代真机证据。reported_symbols_only 保留报告符号，无符号包时不声称构建匹配或完整符号化。

## scrcpy 持续流采样画面

scrcpy_sampled_frame 保留原 pts_us 和视频序号。指标窗口中点 target_ns 与映射后的 device_time_ns 通过 BigInt 精确求差；绝对 selection_delta_ns 不超过 250ms，clock_error_ns 不超过 20ms，frame.begin/end 为设备帧时间减/加误差的区间。本批 epoch 固定 1，不混入断流重连的其他代次；无合格近邻帧以 unavailable 和原因保留指标，capture_frames=false 可为 disabled，画面状态与 Root 堆栈状态分别报告。

每张 PNG 最大 4 MiB，最多 16 张；容器校验宽高最大 16384、总像素最大 67108864、最多 65536 个块。Stored ZIP 全部输入与条目总输出不超过 64 MiB，拒绝重复、路径扩展、隐藏或重叠局部记录、data descriptor、加密、多磁盘、Zip64 与 Deflate。校验 PNG 签名、IHDR、块边界/CRC、IDAT 顺序和最终 IEND；这些校验不替代实际视觉或浏览器解码验收。

生产路线是持续录制后抽取 PNG，本模块消费终态归档，不承诺实时输出或零延时。旧 sampled_screenshot 字段继续兼容读取，不借旧路径的测试证明 scrcpy 真机时间准确性。

reported_sample_count 可选保留 LostSituation 的报告计数十进制原值，与实际解析 stack_sample_count 和 lost_count 分别记录，不假定三者相等或自行补算。当前后端任务结果与索引均保留该字段，旧结果与索引缺省继续读取；索引若携带该字段须与任务结果一致，不把当前结果计数反填到旧索引。

## 可选派生指标

每个采样点可携带独立 derived 对象，api_version 固定 1，不向原 metrics 混入百分比、FPS 或功率。旧索引缺少 derived 仍原样读取，不根据原计数或当前设备能力补值。CPU 两项须同时有值或同时为 null；整机占比为 0–100，单核归一化为 0–logical_cpus×100，核数关系保持一致。有值时仅核相邻样本的身份、时间、核数及差分资格，不在前端重新派生 CPU。

FPS 有值须与原 frame_window 的帧数和窗口时长一致；battery_net_power_mw 有值须有有效设备电池观测和已知电流极性，按 µV×充电正向 µA÷10^9 核对有符号 mW。正值表示充电、负值表示放电，是整机净电池侧功率，不能归因给目标游戏或作为外部供电时整机负载功率。字段按后端返回原样保留，浮点一致性容差为相对 10^-9。

CPU、FPS 和电池功率分别携带 cpu_reason、fps_reason、battery_reason。有值时对应 reason 必须为 null；缺值时必须为不超过 4096 UTF-8 字节的非空原因。原因不使用设备白名单，不将缺测转成零。定点回归在 tests/android-profile-derived.test.ts；本模块不新增产品界面，真实指标准确性与完整前端门禁由主代理独立验证。


## 独立堆栈质量文件

新 captured 归档增加可选 stack-quality.json，旧归档缺省返回 quality=null。消费者将有界质量文件与同一 stacks.jsonl 逐项核对：解析/报告/丢样数、总链帧、空链/单帧/最大深度、深度分布、原始错误码配对、缺符号帧和样本。新文件矛盾或未知模式失败时不交付部分归档；unavailable 不接受质量文件。quality 经 OpenedProfileArchive 返回，具体产品页面不在本批实现。

capture 声明本轮固定 cpu-clock/99Hz/DWARF/boottime 和关闭报告去隙；不证明完整展开。展开元数据缺失、携带非零错误和有元数据且错误为空/零分别计数，不将最后一种称为成功展开。空字符串或 null 符号均属缺符号；不补函数名。protobuf 没有目标 ELF 架构或 Build ID，汇总明确 unavailable，保留原始 perf.bin 供后续有资格的离线分析。

## 火焰图纯数据模型

用户接受缺符号作为当前边界。buildProfileFlamegraph 直接消费已解码 stacks；旧归档无需增加字段即可计算。事件→进程→线程→根到叶帧分别聚合，原叶到根数组不修改。已知函数按模块、执行类型与完整函数名合并地址；未知函数按模块、执行类型与规范化地址保留热点，标签使用模块及地址，不补函数名。递归函数保留不同深度，空栈计入线程自权重，不插入虚构调用帧。

默认权重为每条样本 1；可选 event_count 使用原 u64 事件计数，事件类型分别置于顶层，不能将不同事件混成 CPU 耗时。所有累计权重及布局坐标输出十进制字符串，经 BigInt 精确累计，累计可超过 u64。nodes 提供父节点 ID、深度及 startWeight/endWeight，坐标相对全图，children 提供树形结构；展示层自行映射到屏幕像素。节点按聚合身份确定顺序，ID 只在本次模型内有效。

processIds 支持精确筛选未知进程 null；threadIds 筛选线程 ID；beginNs/endNs 为 boottime 半开区间 [beginNs,endNs)，未指定端点不设边界。空筛选集合或相等端点得到空树，未知进程不会自动归属于录制 PID。quality 保留每个聚合节点及全图的展开错误、展开元数据缺失与缺符号样本数；这些标记不表示完整展开。筛选后的空栈和原零事件计数分别保留。

模型最多消费 100000 条原栈，每条最多 256 层，筛选 ID 最多 100000 个，聚合节点最多 200000 个；超范围失败，不静默截断。可传 AbortSignal，中止时不交付部分模型。tests/android-profile-flamegraph.test.ts 覆盖精度、半开筛选、函数身份、未知符号、递归、空栈、质量、自权重及资源/取消边界。具体图表组件及浏览器验收由主代理独立集成。
