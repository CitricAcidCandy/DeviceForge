# 投屏业务插件

当前接入真实 scrcpy 工具检查与 H264/MP4 有界录制，贡献为 runtime.status 和 record。record 使用 device_id、duration_ms（1000–120000）、max_size 与 max_fps；设置 no-playback/no-control/no-audio 供无桌面的服务器录制，干净完成后验证 MP4 头部并返回 screen.mp4 产物。工具输出大小在运行中检查，超过 128 MiB 取消并等待直接进程退出。

部署者通过旁置 mirroring.config.json 固定 scrcpy 与 adb，请求不选择入口路径。失败不发布部分视频，清理未确认保留 Failed，不以直接进程回收推断所有远端资源。

已通过旧工程实际 scrcpy --help 核对 time-limit/no-playback/video-codec/record 参数。浏览器直播、低延迟解码、音频、实时输入控制、常驻会话重连与真机尚未实现或验收；录制不能表示完整投屏迁移完成。
