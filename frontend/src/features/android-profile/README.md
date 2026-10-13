# Android Root 堆栈与采样画面消费

本模块采用 plan-and-build，消费冻结的 stack.probe v1 与 profile.record v1，不创建产品页面，也不改变宿主 SDK 或 runtime。通过公开 host.devices.invoke 携带完整设备引用；宿主负责转换为 {device_id,input} 封套。外部任务操作为 plugin.android-device.stack.probe 与 plugin.android-device.profile.record。

## 职责

- types/rules：独立插件业务模型、输入和资源边界；任务、产物及设备观测引用共享公开契约。
- observations/metrics：原 PerformanceSample 与设备观测严格校验，不补 sequence、CPU 百分比或 FPS。
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

reported_sample_count 可选保留 LostSituation 的报告计数十进制原值，与实际解析 stack_sample_count 和 lost_count 分别记录，不假定三者相等或自行补算。当前后端仅任务结果带此字段，旧结果与索引缺省继续读取；索引若携带该字段须与任务结果一致，不把当前结果计数反填到旧索引。
