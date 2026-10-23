# 投屏业务插件

普通贡献为 runtime.status 和 record。record 使用 device_id、duration_ms（1000–120000）、max_size 与 max_fps；设置 no-playback/no-control/no-audio 供无桌面的服务器录制，干净完成后验证 MP4 头部并返回 screen.mp4 产物。工具输出大小在运行中检查，超过 128 MiB 取消并等待直接进程退出。

部署者通过旁置 mirroring.config.json 固定 scrcpy 与 adb，请求不选择入口路径。失败不发布部分视频，清理未确认保留 Failed，不以直接进程回收推断所有远端资源。

新增协议 5 会话贡献 open，通过部署者固定的 scrcpy-server 3.3.1 或 3.3.4 与 ADB 提供 H264 Annex B 视频、48 kHz 双声道 PCM s16le 音频、实时触摸/按键/文本/剪贴板/旋转/视频重置。推荐部署官方 3.3.4，`live.server_version` 必须与服务文件一致；Android 17 的新增显示回调会使旧 3.3.1 进程崩溃，3.3.4 已包含上游兼容修复。启动、就绪与清理共同使用本次经过白名单校验的版本身份。打开输入只指定设备与有限编码参数；部署配置示例见 mirroring.live.config.example.json。默认由设备选择编码器；可在 `live.video_encoder` 指定经过目标设备验证的名称。三星本轮实测中 `c2.android.avc.encoder` 触发系统原生崩溃，移除强制值后选中 `c2.qti.avc.encoder`。该设备强制设置 Baseline 参数也触发系统崩溃，相关尝试已撤销，WebRTC 仍按真实 SPS 生成协商。名称只接受 1 至 128 字节的 ASCII 字母、数字、点、下划线和短横线，不由浏览器请求选择。旧格式 1 和旧录制协议保持。

媒体采用 DFML 24 字节包头，包含类型、关键帧/配置标志、微秒时间戳、长度和代次。单载荷最多 4 MiB，按完整帧串行经过 8192 字节公开会话块。会话采用有界尾部缓存与连续输出模式，原截止点最长一小时；不能从过期游标或截断媒体继续解码。控制为 UTF-8 JSON 行且必须匹配当前 epoch，不回放旧代控制；EOF 只关闭控制输入。精确合同见 [实施文档](../../docs/implementation/投屏直播插件实施.md)。

WebRTC 按设备独占控制：普通参与者申请接管，由当前控制者同意或拒绝；服务端根据实际 TCP 来源确认的本机主控可以抢回。每位观看者保留自己的视频连接，只有当前控制者拥有独立的设备控制连接。移交先持锁保存 `transitioning`，随后释放协调锁，补发按键和触摸释放并确认旧控制端清理；最后重新取锁核对最新移交目标，再完成授权。移交期间所有客户端都不能发送设备输入，其他观看者仍可读取状态，画面连接保持播放。兼容 `open` 只允许观看，设备控制统一走 WebRTC；首期 WebRTC 固定关闭音频。

打开参数 `clipboard_autosync` 默认关闭。启用后，独立控制端接收设备原生复制菜单和 `get_clipboard(copy/cut)` 的剪贴板变化，只向当前控制者的可靠数据通道回传。观看连接始终关闭剪贴板自动同步。每条输入和回包带独立 `control_revision`，普通申请不改变这一代次，移交或失权后丢弃旧代正文。剪贴板按 8192 字节分片，总上限为 262139 个 UTF-8 字节；未知、截断、超限和非法 UTF-8 消息终止本会话。手机本地触控或应用自行改写剪贴板不带浏览器操作者身份，只能按当时的远程控制权归属。

控制权命令携带 `request_id`，服务端通过 `control_result` 返回接受或拒绝原因，浏览器收到匹配回执后完成操作。客户端上下文通过可选的 `sessions.client_context` 声明接收，旧插件保持原打开帧。局域网开发必须直连后端，避免回环代理把所有观看者认成本机。协调状态、资源失败与本期崩溃恢复限制见 [控制权模块](src/live/ownership/README.md)。

本次远端目录、服务文件、pid、SCID 和 ADB 转发分别登记。设备清理先取消并等待本地 ADB 流式进程，由公共工具库使用独立回收预算；该等待结束后，远端进程、独占目录和精确转发的清理命令共用新建的两秒绝对期限，不逐条续期，也不让本地退出等待消耗远端命令预算。失败保留 Failed，不执行 kill-server、pkill 或全局清理。设备断开仅在清理全部确认后有限重连，未确认的远端资源不能由本地 ADB 退出替代。

2026-10-23增加清理阶段的有限兜底：尚未确认的目录与转发阶段最多尝试两轮，仍共用首次远端截止点；确认成功的阶段不重复。删除回执失败可同预算查表确认，但PID、端口归属冲突、非法输出及直接进程未确认不会被重试成功覆盖。精确限制见[设备清理模块](src/live/device/cleanup/README.md)。WebRTC清理失败另保留原始业务错误并列出失败阶段。该早期补丁本身不解除宿主cleanup_failed或控制权blocked；后续独立恢复实现见下一段，不将早期测试转计新版本通过。

2026-10-23后续接入[持久资源台账与自动恢复](src/recovery/README.md)：首个ADB副作用之前原子记录意图、各阶段更新、入口与工具监督持租约、同设备恢复和登记互斥。新直播先核对旧资源与持久控制状态；协议4特殊操作runtime.recover全插件核对，明确coverage、inspected及remaining，不混入普通operations。确认后才撤台账及恢复blocked，宿主另根据真实协议终态决定解除全局风险。未知旧资源和外来转发不猜测清理；普通录制也记录外部工具资源债务。真实WebRTC复开与真机验收仍独立于单元测试。

WebRTC 会话最终用 `tokio::join!` 同时收口 Peer、视频设备资源与独立控制端，等待三路清理全部结束后汇总结果，避免串行叠加；任一路失败都返回清理未确认。控制端内部仍先释放输入和设备资源，再按真实结果注销控制权。宿主合作取消窗口为五秒，但工具超时后的进程回收和文件操作仍有各自等待，当前证据不保证所有故障路径都在五秒内完成。

2026-10-16 最新投屏库回归为 [60/60](../../../artifacts/mirroring-ownership-final-20261016/mirroring-test-cleanup-budget.log)，相同版本的 [Clippy](../../../artifacts/mirroring-ownership-final-20261016/clippy-cleanup-budget.log) 与 [debug 构建](../../../artifacts/mirroring-ownership-final-20261016/build-cleanup-budget.log) 完成。隔离宿主、三个真实浏览器 WebRTC 会话及独立假 ADB 连续两轮均为 12/12：[首轮报告](../../../artifacts/mirroring-ownership-smoke-9922db88-b89a-49f3-bd01-6a8ad9f64579/report.json)、[第二轮报告](../../../artifacts/mirroring-ownership-smoke-38b3506a-ef3a-4163-b561-a401779945b4/report.json)。覆盖申请、拒绝、同意、主控抢回、三次复制归属、旧代与越权输入零字节、合法输入共 84 字节，以及六组视频/控制资源清理和插件卸载。

两轮插件 SHA-256 均为 `4e5c84c9d758c7c65f355d1e7125f1e2d5e82a865ddd4be4eb00159a8e452481`；同一文件已完成 [预览部署热更新](../../../artifacts/mirroring-hot-update-995782a9-8438-4b5b-b23b-5a9e32f8f622/report.json)，该次记录中宿主 PID 前后均为 61720。上述浏览器联调使用合成媒体和设备回包，三名客户端均来自本机；不代表手机原生复制菜单、真实设备、非主控局域网操作、延迟性能、正式包或跨平台验收。崩溃后的持久化阻断限制仍见控制权模块，性能专项按用户安排延后。

2026-10-16 真机增量：[正常 GPU 浏览器报告](../../../artifacts/webrtc-gpu-browser-1792140623566/report.json) 七项通过，三星 SM_G991U 自动选中 `c2.qti.avc.encoder`，实际 offer 的 H264 profile 为 `640020`、浏览器 answer 为 `64001f`；本轮未额外保存原始 SPS 字节。画面为 576×1280，播放统计 15 帧且零丢帧，入站统计已解码 30 帧；实际 ICE 候选对两端均为 UDP。子代理审核画面清晰，无黑屏、绿屏或破图。仅发送无副作用 keycode 0 的 down/up 和 reset，不把通道接受当作实际文字复制或键盘操作验收。

本次发现探针的 `--disable-gpu` 会移除该浏览器的 High profile 接收能力，现已移除；强制设备 Baseline 的尝试导致系统编码器崩溃，生产参数已撤销。[最终插件热恢复](../../../artifacts/mirroring-hot-update-b7ce274e-630d-4ecb-a4cf-30f2a429d961/report.json) 仍使用上述 `4e5c84…` 文件，宿主 PID 61720 不变。本次会话、转发、远端目录、浏览器及临时端口均释放，手机 OFF，既有外部 scrcpy 5.0.1 三进程保留。资源快照见 [真机验收目录](../../../artifacts/mirroring-real-device-gpu-20261016-164948)。手机原生复制菜单、同事 LAN 操作及端到端延迟仍须独立验收。
