# Android Root 与连续采样画面独立验收

本目录驱动冻结宿主与 Android 插件，通过公开 HTTP/MCP、共享 Job、真实下载字节及实际前端产物消费验收。已通过的 FPS 和设备电气/温度功能不重跑。性能专项、容量与压测按用户要求延后。

## 已通过的四批真实服务

以下四批均 report.passed=true，driver 与宿主实际退出 0，宿主正常关闭且端口释放。原工具与父插件 OS 句柄退出原件已逐份回读，所有探针均 exit 0，test_kill=false。

- 资格：artifacts/android-profile-probe-service-debug-8396f976-5043-4186-86f8-81fbf6a39f8e/report.json。8 项检查、6 Job、20 工具、139 响应日志 ID；覆盖 adbd Root、su 成功/拒绝、无 Root、无 Simpleperf 和缺 required help。
- Root 录制：artifacts/android-profile-record-service-debug-744c0525-1dae-4043-b929-51abea04a34d/report.json。4 项检查、2 Job、76 工具、342 响应日志 ID、4 下载；核原 perf bytes、官方 protobuf 晚表、排序/未知符号、窗口关联、ZIP 大小/SHA/CRC及实际前端联合消费。
- 无 Root 回退：artifacts/android-profile-record-service-debug-0cb818fc-a3ec-417a-9f40-29c49326d743/report.json。5 项检查、3 Job、63 工具、316 响应日志 ID、6 下载；无 Root、su 拒绝和 Simpleperf 不可用仍录制指标，归档为空栈且无 perf。
- 生命周期：artifacts/android-profile-record-service-debug-b6213ce3-76c2-44f1-943a-b6df7d4cea02/report.json。4 项检查、3 Job、94 工具、249 响应日志 ID、2 下载；cancel/unload 终态 cancelled、result=null，后续实际 cleanup 原字节 clean\n 已确认，重载代次独立且新任务 succeeded。

以上录制均 capture_frames=false、frame_status=disabled。它们证明无画面合同，不能外推为连续媒体已完成。每批 driver-exit.json 保存实际 close、输出与报告身份。

成功批使用 artifacts/android-profile-record-debug-frozen-4fd1b68f-d01e-47a7-9132-9f8d446905aa 冻结输入；三文件前后 SHA 稳定：

- 宿主：f375246aadd89709a7b7e4daa9f81e7ba2cc55cf1f8b8f96bf60b3ae22a1f1f0
- 插件：df3a9c9bd396c59be1b32e084d7a24950c6dd9a42fb47c24e688abfca4facff1
- 清单：403216f07e8f06eefc0689ba0f26331d1beaa65e64fd4517412d20635256e0c4

## 保留的失败与处理

失败目录不删除，不用后续成功覆盖其结论：

- android-profile-probe-service-debug-9ccaac31-afdb-49db-8bed-19f8cb1b401b：旧 13 贡献包错拒宿主自动输出授权，真实 Job error 为“依赖执行失败：输入无效：性能采样不接受产物输出授权”。生产修正后改用上述 14 贡献冻结包。
- android-profile-record-service-debug-cb9f9c0b-bc5d-4aed-b784-eb23ecf52762：两正常录制通过，但驱动将取消 Job 终态误当远端清理完成，PROFILE-CANCEL-REMOTE-CLEANUP 失败。修驱动等待实际 clean\n 与 completed 回执，不改生产。
- android-profile-record-service-debug-523ffbbe-0e3a-43ad-91dc-7b40123b3e03：前三检查通过，call106 的 OS 探针 OpenProcess 返回 87；繁忙探针启动与 750ms 资格期限竞争。拆成小矩阵通过，不放宽生产期限。

这些目录均保存 driver-exit.json，宿主正常退出 0 且端口释放。

## 独立夹具与媒体准备

protocol.mjs 按 Android 官方 cmd_report_sample.proto 独立编码 SIMPLEPERF bytes，不导入生产解析器。黄金报告先样本后符号/线程表，含乱序/等时间稳定排序、未知符号和叶到根调用链。downloads.mjs 核下载大小/SHA；zip.mjs 核 Stored ZIP 的 local/central/EOCD、CRC、无重复/路径穿越/重叠/隐藏字节。frontend.mjs 冻结并实际导入前端相对模块，校验发布 metadata 与归档联合消费。

fake-adb.rs 只接受精确冻结 argv。远端 SHA256 token 每场景独占且不可变，除明确受检 token 之外的脚本逐字匹配。processes.mjs 在放行 ADB 前取得工具和父插件原 OS 句柄，按计划回读真实退出码；test_kill 必须为 false。

连续媒体按 scrcpy 3.3.1、H.264、原 PTS、双设备时钟锚点与采样中点选邻帧独立准备。使用真实 ffmpeg/ffprobe 和本地 TCP 原字节；固定远端目录/nonce/scid、服务 argv 与 forward 所有权逐字匹配。后续重点为无 Root 仍可画面采集、时间过期/offset 跳变不可错误关联、cancel/unload 与 forward 归属冲突。下方连续媒体批次记录实服证据与精确插件身份；更新的生产脚本须新冻结验收，不能外推。

## 证据边界

合成 SIMPLEPERF bytes、原生假 ADB 和本机 TCP 不替代 Root 真机、Android/OEM、实际游戏、scrcpy 真实设备采集、符号包或页面视觉验收。原 OS 句柄证明本次直接 ADB 与父插件，合成远端回执不证明真实 Android PID 退出。PNG 黄金只核原字节、CRC和时间关联，不作视觉结论。冻结便携目录也不等于正式 TGZ/npx 或另一局域网主机交付。

## 连续媒体当前已通过批次

使用 artifacts/android-profile-media-debug-frozen-466eb836-381f-4aa3-8f64-83ca905ee054：host SHA 与无画面批相同，plugin SHA 为 237675a6a4002a75d97c9ab7d29529584c1b8e5391d5970c666f207298de9843，清单 SHA 相同。scrcpy 3.3.1；真实 ffmpeg/ffprobe 固定入口；所有输入/前端源快照前后身份稳定。

- 正常：artifacts/android-profile-media-service-debug-6be89ed2-affd-4658-98ef-b0e69ee4fd4f/report.json。4 检查、2 Job、81 工具、4 下载。Root 栈+画面与无 Root 空栈+画面均 captured；选 video_frame_index=1、PTS=8055001、device_time_ns=10055000000、delta=0、error=2000，与独立黄金完全一致。PNG 原字节与实际前端消费相等。逐份 OS 原件：79 target=0、两媒体服务由生产取消 target=1，81 parent/probe=0、test_kill=false。
- 时钟：artifacts/android-profile-media-service-debug-f7f91f51-5131-473c-8359-774c986352df/report.json。4 检查、2 Job、97 工具、4 下载、512 响应日志 ID。过期 PTS 与 offset 跳变均 unavailable，并保留指标/栈/归档，固定原因及实际前端消费通过。逐份原件：95 target=0、两媒体服务 target=1，97 parent/probe=0、test_kill=false。
- 生命周期：artifacts/android-profile-media-service-debug-8906624b-b392-4c18-b7a2-d5d6454aeb96/report.json。4 检查、3 Job、125 工具、2 下载、318 响应日志 ID。cancel/unload cancelled/result=null，完整 TCP 原字节、DFPC_VIDEO_CLEAN 回执、自有 forward 删除和复核通过；新代重载录制成功，旧 Job 历史保持。逐份原件：120 target=0、两 held 与三媒体服务 target=1，125 parent/probe=0、test_kill=false。

以上 driver/host 均真实退出 0、宿主正常停止且端口释放；driver-exit.json 和 os-audit.json 保存实际退出及逐份原件审计。FFmpeg 黄金为三个可辨 I/P/P 帧，PNG SHA 各异；这些属于本地 TCP+合成设备协议功能证据，不宣称三星真机媒体已通过。

媒体驱动失败同样保留：816e4245-95ae-4706-ba2d-ffc2d976a421 在服务前对被冻结默认配置调用 Object.assign，已改独立副本；a6bfa332-5a80-4ea3-8363-8565cc6ef861 漏计 stop_and_select 失败后外层幂等 cleanup 重试；74124f9e-efed-4d4f-ae40-26e503b55ad1 已通过 foreign-forward 业务，但驱动误要求普通卸载成功，真实 HTTP 409 cleanup_failed 是生产隔离合同，已按其核验。后三者均无生产修改，原报告与实际 driver/host 退出保留。

- 端口归属冲突：artifacts/android-profile-media-service-debug-eea8638c-a346-43f7-809b-77921bac48b1/report.json。4 检查、1 Job、49 工具、260 响应日志 ID。Job failed/result=null，插件调用结束为 cleanup_failed；两次幂等媒体清理与 forward 清单均保留 foreign port，未调用 forward --remove；普通卸载 HTTP 409 cleanup_failed，旧 Job 历史不变。逐份原 OS：48 target=0、一媒体服务生产取消 target=1；49 parent/probe=0、test_kill=false。driver/host 均 0 且端口释放。

另保留 b6ea9f24-ff48-48d0-8eab-26a667bc32eb：3 业务检查与 49 工具 OS 门禁通过，但旧共享日志校验将 failed 固定为 dependency_failed，真实为 cleanup_failed；新增本目录 logs.mjs 按场景核精确结束码，并继续核全部响应 ID 与 Job/log_id/request_id 唯一配对。成功轮未放松预期。

2026-10-13 后续生产修正准备：server argv 精简到设备兼容上限以下，清理 cmdline 为 dfv_scid；SurfaceFlinger 改固定 exec-out dumpsys SurfaceFlinger --proto。自有黄金已接线，尚待主代理新构建/冻结验收。这些更新不改变上面旧 237675a6 插件证据的版本边界。

## 短启动参数与 SF 原始字节新冻结回归

新包 artifacts/android-profile-short-window-frozen-8c424e1b-0536-4651-b969-9a00da427388：host SHA eefc4e7660213b3206938ceeb286677c8d20a5a053477705953342816dd8b7a0；plugin SHA 66b957a4d18860da9653620a299a2eb44e4e996a150843117dd22bc691ac5f46；manifest SHA 与前批相同。实际 app_process 参数为 239 ASCII 字符，保持 2Mbps/audio=false/control=false，清理 cmdline 为 dfv_scid，原身份写 /proc/$$/stat。SF 固定 exec-out dumpsys SurfaceFlinger --proto，空 proto 保持缺 FPS 的真实指标回退。

- 新正常批：artifacts/android-profile-media-service-debug-a0e5cb8e-ceba-46b9-ae84-0a4ff41e4d31/report.json。4 检查、2 Job、82 工具、424 响应日志 ID、4 下载。Root 与无 Root 画面/PTS 黄金、实际前端归档消费、源与副本前后身份通过。82 原 OS 已逐份回读：80 target=0、两媒体服务由生产取消 target=1；全部 parent/probe=0、test_kill=false；driver/host 0，端口释放。
- 新生命周期批：artifacts/android-profile-media-service-debug-7b9e2495-3062-4d80-8f3d-d6704b565fb9/report.json。4 检查、3 Job、128 工具、388 响应日志 ID、2 下载。取消/卸载 result=null、固定媒体清理及 forward 删除/复核、新代画面产物与历史不变通过。128 原 OS 回读：123 target=0、两 held 与三媒体服务生产取消 target=1；全部 parent/probe=0、test_kill=false；driver/host 0，端口释放。

本轮只回归新命令与清理影响范围，未重跑未变化的时钟异常规则；旧时钟通过证据保留原版本边界。派生指标 derived 尚未落入此冻结包，不借本轮通过宣称 derived 完成。

- 新归属冲突批：artifacts/android-profile-media-service-debug-d6a6e40a-9184-4c1b-b7e5-1c27ff4ddbd4/report.json。4 检查、1 Job、50 工具、263 响应日志 ID。Job failed/result=null、结束码 cleanup_failed，两次媒体清理/list 均保留 foreign port、无 remove；普通卸载 409 cleanup_failed，历史不变。逐份原 OS：49 target=0、一媒体服务生产取消 target=1；50 parent/probe=0、test_kill=false；driver/host 0，端口释放。新包三批均无驱动失败，全部进程已收口。

## 派生指标、编码头就绪与同代僵尸清理最终新包

最终新包 artifacts/android-profile-derived-ready-frozen-b2a390b6-b9ad-4da4-a584-661ed9ab2902：host SHA eefc4e7660213b3206938ceeb286677c8d20a5a053477705953342816dd8b7a0；plugin SHA 33d1eefbbfec3aeac2a4997132ed4f7e27f72e3ed7e108a72adb02c4b868a38e；manifest SHA 403216f07e8f06eefc0689ba0f26331d1beaa65e64fd4517412d20635256e0c4。

该包 Device.connect 读完并核验 12 字节编码头才返回，固定 5 秒内早 EOF 可重试；capture 使用已读取编码头。远端 owned_state 先核原 PID/starttime，再读取活动进程 cmdline；同代 Z/消失可收口，PID 复用不接受；远端步骤先于本地 ADB 回收。自有夹具编码头原字节不变，清理脚本逐字同步。驱动 18 输入和 native SHA 已在启动前逐份核冻结身份，记录见媒体黄金目录 final-driver-freeze.json/final-golden-differences.json。

- 最终正常批：artifacts/android-profile-media-service-debug-76d02c06-1a96-4122-915a-131db1c3b6b2/report.json。4 检查、2 Job、82 工具、433 响应日志 ID、4 下载。Root 与无 Root 首样 derived 精确八字段通过：api_version=1，CPU 两值/FPS/电池净功率均 null，原因分别为“首个采样缺少相邻 CPU 计数”“未取得主进程展示帧窗口”“未取得设备电池观测”。画面 PTS/选帧原字节及实际前端整个 index/PNG 联合消费通过。82 原 OS 逐份核全部 target/parent/probe=0、test_kill=false；driver/host 0、graceful、端口 52108 释放。

本目录合成原字节只证明新协议和控制流程，不把空 SF/电池样本当真实 FPS/功率数值证明；真实零、功率极性和多样本 CPU 另依后端纯规则及真机证据。这里也不证明早 EOF 重试或真实 Android 僵尸过程，分别按连接规则测试和主代理真机记录验收。

- 最终生命周期批：artifacts/android-profile-media-service-debug-675b5ce3-b9b6-447b-b496-277eb79a7dfd/report.json。4 检查、3 Job、128 工具、282 响应日志 ID、2 下载。cancel/unload 固定 owned_state 清理/实际 clean 回执、自有 forward 删除与复核，新代 derived/PNG 实际前端联合消费及旧历史保持通过。128 原 OS 逐份核：124 target=0，两次取消/卸载各媒体服务和 held receipt 共 4 target=1；128 parent/probe=0、test_kill=false；driver/host 0、端口释放。
- 最终归属冲突批：artifacts/android-profile-media-service-debug-a8ada9cb-beb4-4638-87d8-0ea64a2af6a7/report.json。4 检查、1 Job、50 工具、238 响应日志 ID。Job failed/result=null，结束码 cleanup_failed；两次媒体清理/list 保留 foreign forward，未执行 remove，普通卸载 409 cleanup_failed，历史保持。50 原 OS 逐份核全部 target/parent/probe=0、test_kill=false；driver/host 0、端口释放。

最终三批的 260 份 process.ready.json 及 process.exit.json 已逐份回读，与报告原件相等，target/parent 的原创建时间从 ready 到 exit 一致。原件审核记录见各目录 os-audit.json、os-ready-audit.json；driver-exit.json 保存真实 close、完整输出与报告 SHA。所有驱动/工具/probe/host 已收口。本轮不重跑未修改时钟异常，不以历史包通过外推新包；新包只有必要三批成功，无驱动失败。

## YCgCo 颜色修正的验收边界

2026-10-13，media-golden.mjs 的 FFprobe show_entries 同步为 frame=pict_type:stream=color_space，普通 PNG 转换参数保持原值。真实三帧黄金通过，帧型仍为 I/P/P，三 PNG 字节身份各异，编码、探帧、解码工具实际 close 均 exit 0，语法检查 exit 0。证据位于 artifacts/android-profile-color-golden-256a62e4-af97-41a5-ba72-8e755144281c/ordinary-golden-report.json 和 driver-freeze.json。与上轮冻结比较，仅 media-golden.mjs 一项 SHA 改变；旧 final-driver-freeze.json 保留上轮证据，不再代表当前驱动身份。

主代理已收到真机 YCgCo 的 zscale 抽帧可解码证据，但视觉子代理判定色彩未通过，不能记录为颜色正确或业务完成。当前不运行 colorfreeze 新包，也不重跑生命周期、转发归属、时钟和性能专项；等生产颜色路线修正后再按新冻结包进行必要普通 Root/无 Root 小批。之前 14 个自有媒体驱动均已 close，本次三个黄金工具和语法检查也全部收口。

2026-10-13 后续官方源头编码路线已同步：服务参数 254 ASCII 字符，nice-name 为 scid，追加 video_codec_options=color-standard:int=1，并使用默认 dummy=true。TCP 黄金发送值为 0 的 dummy 后跟原 12 字节编码头；清理 cmdline 按 scid 比较，FFprobe 恢复 frame=pict_type。三项语法与真实普通三帧编码/探帧/解码均 exit 0，dummy/编码头/首包偏移 13 已核。新驱动冻结及差异见 artifacts/android-profile-official-golden-400c799f-77f8-4184-acaa-b4a191ef279d/driver-freeze.json；等待主代理新包后只回归正常、生命周期和转发归属，不执行旧包，真机颜色由视觉子代独立审核。

## 官方 BT709 源头设置最终必要回归

新包 artifacts/android-profile-bt709-frozen-6fb10754-451e-4d50-9241-e7d7630445c6：host SHA eefc4e7660213b3206938ceeb286677c8d20a5a053477705953342816dd8b7a0；plugin SHA 2531842a339a9d8ed385bc9bd468b11799786e61d324a0f100105d5634be00e8；manifest SHA 403216f07e8f06eefc0689ba0f26331d1beaa65e64fd4517412d20635256e0c4。源与冻结副本前后身份稳定，18 项驱动输入及 native 与启动前冻结相同。

- 正常：artifacts/android-profile-media-service-debug-4842de21-803f-4497-8017-f3fe8bd5af90/report.json。4 检查、2 Job、82 工具、412 响应日志 ID、4 下载；Root/无 Root 首样 derived、PTS邻帧、PNG原字节和真实前端联合消费通过。82 target/parent/probe 全为 0。
- 生命周期：artifacts/android-profile-media-service-debug-9a3a5c2c-3fe4-40ab-a661-075e2ffca574/report.json。4 检查、3 Job、128 工具、277 响应日志 ID、2 下载；cancel/unload cancelled/result=null，新 nice-name 清理实际回执、forward 删除复核、新代重载及旧历史保持通过。124 target=0，取消与卸载各 held receipt/媒体服务共 4 target=1；128 parent/probe 全为 0。
- 转发归属：artifacts/android-profile-media-service-debug-9474d816-e421-49b8-8dae-e8b5adf99b43/report.json。4 检查、1 Job、50 工具、236 响应日志 ID；Job failed/result=null、结束码 cleanup_failed，foreign forward 保留、未 remove，普通卸载 409 cleanup_failed及旧历史保持通过。50 target/parent/probe 全为 0。

三批合计 12 检查、6 Job、260 工具、925 响应日志 ID、6 下载；driver/host 实际退出均 0，宿主 graceful、端口全部释放，test_kill=false。260 份 ready/exit 原件逐份与报告相等，PID及原创建时间一致，各目录保留 driver-exit.json/os-audit.json/os-ready-audit.json。汇总见 artifacts/android-profile-official-golden-400c799f-77f8-4184-acaa-b4a191ef279d/final-bt709-media-batches.json。所有自有进程已收口，未新增构建、时钟或性能测试。本轮只证明原生假 ADB+本机 TCP 功能合同；实际游戏画面/颜色仍以真机和视觉子代证据为准，不把壁纸当游戏。

## 最终 workspace debug 新字节独立回归

2026-10-13，新包 artifacts/android-profile-workspace-debug-frozen-4b40ba34-2d12-4ae7-bd5c-2b310380c29f：host SHA 9f7cfe9b83cf9b597bd2e83bed364261ecf3f68c997064ae3345807b681fac9a；plugin SHA 5923a5e1632bf7f05a2f607885052ccf10b255ab9c33941d8d16556fa589f08f；manifest SHA 403216f07e8f06eefc0689ba0f26331d1beaa65e64fd4517412d20635256e0c4。启动前核三 SHA，与同一 18 项 BT709/dummy13/254argv 驱动冻结及 native 精确身份一致，未修改驱动/黄金或构建。

- 正常：artifacts/android-profile-media-service-debug-4cf70559-14f2-4c9b-88e8-2af5fe0a1e9c/report.json。4 检查、2 Job、82 工具、436 响应日志 ID、4 下载；Root/无 Root 画面、derived、PTS、原 PNG及真实前端联合消费通过，82 target/parent/probe 全为 0。
- 生命周期：artifacts/android-profile-media-service-debug-9fcf7fa2-374e-437f-ae9c-b662242be952/report.json。4 检查、3 Job、128 工具、288 响应日志 ID、2 下载；cancel/unload cancelled/result=null，固定身份清理/forward删除复核、新代归档与旧历史通过；124 target=0、4 生产取消 target=1，全部 parent/probe=0。
- 转发归属：artifacts/android-profile-media-service-debug-554c4279-f070-4f10-ba59-159b7e94ee47/report.json。4 检查、1 Job、50 工具、254 响应日志 ID；failed/result=null、cleanup_failed、foreign forward未remove、普通卸载409与历史保持通过，50 target/parent/probe 全为 0。

三批合计 12 检查、6 Job、260 工具、978 响应日志 ID、6 下载。260 份 ready/exit 原件逐份与报告相等，PID原创建时间一致；6 下载实际字节/大小/SHA 与产物元数据逐份相等；每批43项前端源/快照身份相等，产物联合消费为本批实际执行。三driver/host均实际退出0、graceful，61817/59212/55392端口释放，test_kill=false，所有自有进程收口。三新包文件、18驱动输入与native前后稳定；各目录保存driver-exit.json/os-audit.json/os-ready-audit.json。汇总与启动资格见 artifacts/android-profile-workspace-golden-8fb2f364-7162-458f-a9ee-93ab89498931/final-workspace-media-batches.json及prepared.json。

本轮仅新workspace字节独立功能合同；不连接真机、不重跑时钟/性能，不把旧2531842a插件三星真机或颜色结果外推到新5923a5e1插件，不当作正式分发验收。
