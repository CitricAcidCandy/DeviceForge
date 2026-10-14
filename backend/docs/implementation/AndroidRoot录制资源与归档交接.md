# Android调用栈与采样录制资源交接

更新时间：2026-10-13。实现按当前采样点画面、自动Root探测与无Root兼容裁定推进；专项性能测试延后，下面仅描述代码合同和待执行门禁。

## 公开边界

公开任务贡献为 `plugin.android-device.stack.probe`、`plugin.android-device.profile.record`，设备清单短贡献分别为 `stack.probe`、`profile.record`。两者设备级写访问、120000毫秒原总预算，复用宿主同设备互斥，不新增提供者或平台宿主分支。

输入封套仍为 `{device_id,input}`。探测输入只有package；录制有package、duration_ms、interval_ms和默认true的capture_frames。时长及间隔都为1000至15000毫秒，间隔不得大于时长；最多16次实际指标采样。采集耗时越过多个计划点时跳至未来点，不回放积压的历史采样。

## Root与普通设备

部署profile.root_access支持auto、adbd_root和su_c；默认auto。工具入口来自部署配置，simpleperf默认/system/bin/simpleperf，su默认固定su。业务请求不能提供程序、设备路径或自由脚本。auto先执行id -u；非0时尝试受检固定su -c id -u，每次资格工具750毫秒短上限且共用原总期限。无Root或工具缺所需参数时supported=false；录制仍采真实指标，调用栈标stack_status=unavailable及固定原因，不伪造原trace。

有Root使用cpu-clock、99Hz、调用链、显式boottime和保留展开失败结果。报告使用官方report-sample protobuf与show-callchain；设备help允许时追加show-execution-type。没有符号包，只输出报告已有符号、库和地址，symbolication=reported_symbols_only，不宣称恢复剥离符号或源码行。

## 远端所有权与收口

每任务生成64位小写十六进制随机标记，目录固定为/data/local/tmp/deviceforge-profile-标记。目录独占创建后写owner回执；不允许覆盖已有目录或清理他人目录。

record与report每阶段最多一个Simpleperf。固定监督shell写原PID与starttime，派生shell写自身stat后exec固定Simpleperf，因此采集工具沿用原child PID。监督wait原child并原子写退出码回执。启动身份回执包含launchpid、监督stat和child stat；三者资格、独立PID及原starttime均须成立。正常终态必须同时满足原退出码0和两原进程已退出，ADB客户端零退出不能替代远端终态。

清理按owner和原PID/starttime确认后终止监督和child，再确认原进程退出，删除自有目录并实际检查不存在。启动中出现缺失身份记录时保守报cleanup_failed，不能把未找到进程当作全部资源已释放。任务丢弃Future保留未确认guard。正常持续任务的清理沿用原deadline；取消、超时及终止失败共用首次固定两秒cleanup_point，不续期。清理ADB工具最多750毫秒，不继承已取消token。Root工具资格失败且清理已确认时才允许降级为普通指标录制。

## 时钟、媒体与归档

指标前后读/proc/uptime，以十进制字符串保存纳秒，结束区间覆盖百分秒文本10毫秒量化误差。目标package对应PID、starttime及可取得的UID前后复核；身份变化使整次录制失败。只有处于某实际采样区间内的调用栈索引才关联，每区间最多4096条，超限失败不截断。

画面来自持续scrcpy视频流，按采样目标中点选邻帧；PTS与设备时钟资格由独立媒体模块证明。frame_kind为scrcpy_sampled_frame，display_frame_complete=false。采集区间不代表原子同时，画面不宣称目标游戏独占或每个显示帧。

profile-index.json及profile.zip是唯一公开产物。ZIP采用可定位File写入Stored格式，无目录项、Zip64、加密、多磁盘或数据描述符。固定包含索引、stacks.jsonl，有Root报告成功时附perf.bin；无Root保留空stacks.jsonl并省去perf.bin。采样帧仅frames/000000.png至000015.png，媒体完整性失败撤销帧关联而不伪造画面。

原trace及报告各64MiB，JSONL32MiB、索引1MiB、ZIP整体64MiB。文件复制及报告解析走原受限工作池并有取消检查。授权输出create_new后才登记任务租约；失败和晚取消只撤销自己创建的两份输出，不删除用户或其他任务文件。

## 当前证据边界

探测及报告解析定点库测试由主代理集中执行；真实服务驱动由测试助理独立处理，不阻塞本批剩余实现。当前文档不预记尚未反馈的record构建、Root模拟服务、scrcpy真实手机、OEM/su方言、帧时钟及最终分发结果。正式设备与专项性能分别验收。
