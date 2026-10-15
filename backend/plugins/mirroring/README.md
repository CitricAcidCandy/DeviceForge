# 投屏业务插件

普通贡献为 runtime.status 和 record。record 使用 device_id、duration_ms（1000–120000）、max_size 与 max_fps；设置 no-playback/no-control/no-audio 供无桌面的服务器录制，干净完成后验证 MP4 头部并返回 screen.mp4 产物。工具输出大小在运行中检查，超过 128 MiB 取消并等待直接进程退出。

部署者通过旁置 mirroring.config.json 固定 scrcpy 与 adb，请求不选择入口路径。失败不发布部分视频，清理未确认保留 Failed，不以直接进程回收推断所有远端资源。

新增协议 5 会话贡献 open，通过部署者固定的 scrcpy-server 3.3.1 与 ADB 提供 H264 Annex B 视频、48 kHz 双声道 PCM s16le 音频、实时触摸/按键/文本/剪贴板/旋转/视频重置。打开输入只指定设备与有限编码参数；部署配置示例见 mirroring.live.config.example.json。若设备默认 H264 编码器不产帧，可在 `live` 中配置可选的 `video_encoder`，例如 `c2.android.avc.encoder`；名称只接受 1 至 128 字节的 ASCII 字母、数字、点、下划线和短横线，不由浏览器请求选择。旧格式 1 和旧录制协议保持。

媒体采用 DFML 24 字节包头，包含类型、关键帧/配置标志、微秒时间戳、长度和代次。单载荷最多 4 MiB，按完整帧串行经过 8192 字节公开会话块。会话采用有界尾部缓存与连续输出模式，原截止点最长一小时；不能从过期游标或截断媒体继续解码。控制为 UTF-8 JSON 行且必须匹配当前 epoch，不回放旧代控制；EOF 只关闭控制输入。精确合同见 [实施文档](../../docs/implementation/投屏直播插件实施.md)。

本次远端目录、服务文件、pid、SCID 和 ADB 转发分别登记。取消关闭三路套接字，核对远端 pid/cmdline 身份并确认退出，再删除独占目录和精确转发；失败保留 Failed，不执行 kill-server、pkill 或全局清理。设备断开仅在清理全部确认后有限重连。未确认的远端资源不能由本地 ADB 退出替代。

直播生产已通过 16 项定点库回归、全目标 Clippy 和宿主/插件 debug 构建。新冻结副本与实际日志见 [实施文档](../../docs/implementation/投屏直播插件实施.md)。独立模拟工具/套接字、宿主热卸载、浏览器实际解码/音频播放、真实 ADB/scrcpy-server、真机、正式包、跨平台分别验收；性能专项按用户安排延后。
