# 投屏 WebRTC 实施

## 架构裁定

模式为 architecture-first，使用 SDD 与定点行为验证。目标为浏览器实时画面和音频使用 WebRTC，保留可靠设备控制、取消和释放；当前 7031 宿主不得重启。影响范围仅投屏插件、前端消费与所属文档和验证工具，不修改宿主公开 SDK 或路由。

比较同 ID 增量贡献和独立插件：选择在原 mirroring 插件增加 `open_webrtc`，复用已验证的设备资源所有权，避免复制 ADB 清理逻辑。旧 `open`、录像和运行查询保持原合同。当前无活动会话，构建和独立验证后通过公开卸载、精确替换部署插件、重新加载完成更新；加载前核实清理完成，失败保留旧包以便恢复。宿主进程及二进制保持不变。

| 单元 | 负责 | 不负责 | 输入输出与副作用 |
| --- | --- | --- | --- |
| manifest、live 入口 | 新贡献声明及分流 | 媒体实现 | 原有会话 5 到对应执行器，无新增宿主 API |
| live/device | 固定部署工具、独占 ADB/scrcpy 资源、编码模式 | WebRTC 协商 | 参数到设备套接字；进程、文件和转发 |
| webrtc/signaling | 有界版本化 JSON 行 | 媒体缓冲 | 可靠会话字节到 SDP 与状态 |
| webrtc/peer | ICE、DTLS、SRTP、RTP 轨道及 RTCP | ADB 进程 | H264/Opus 原包到浏览器；UDP 套接字，关闭确认 |
| webrtc/lifecycle | 原期限、取消、设备和 peer 清理 | 伪造连接恢复 | 会话到 Execution，清理失败保留 Failed |
| 前端 WebRTC 模型/适配 | 信令消费、PeerConnection、代次、释放 | 旧 DFML 解码 | SessionGateway 到远端 MediaStream |
| 媒体展示/页面 | video 绑定、音频播放和坐标控制 | 直接 HTTP、SDP 编解码 | 用户操作到业务用例，DOM 与播放资源 |

新增媒体路径按职责拆入 `plugins/mirroring/src/webrtc/`；现有设备模块只增加显式编码模式，不复制资源代码。前端独立 WebRTC 模型和适配，原 DFML 模型继续使用。当前实现的边界为本机与可直连局域网，公网 NAT 穿透和 TURN 部署另行配置设计，不声称裸 UDP 可直接由网页消费。

## 信令合同 1

贡献为 `plugin.mirroring.open_webrtc`，打开参数与旧 `open` 一致，使用协议 5、bounded_tail。一个会话仅一代协商，`epoch=1`，不自动重放旧控制或静默重连；连接失败须释放后重新打开。会话 stdout 为 UTF-8 JSON 行，每行不超过 65536 字节（含换行），允许跨会话块和 HTTP 页；输入也为相同有界 JSON 行，单会话仅接受一个 answer。

服务端输出 `{"version":1,"epoch":1,"type":"offer","sdp":"..."}`，等待 ICE 收集完成再发送完整 offer。客户端输入 `{"version":1,"epoch":1,"type":"answer","sdp":"..."}`，同样等待完整 ICE 收集，不使用 trickle ICE。双方只传最少 SDP 和状态，媒体不经过宿主 JSON 管道。信令收集与协商有独立超时且受原会话期限和取消约束。

服务端状态为 `{"version":1,"epoch":1,"type":"status","state":"connecting|streaming|audio_unavailable"}`。视频尺寸来自远端 video 实际解码尺寸；控制输入为 `{"version":1,"epoch":1,"type":"control","command":{旧控制对象}}`，最多 4096 字节且拒绝未知字段，允许 control=false 的会话完成信令但拒绝设备控制。现有可靠会话输入累计 1MiB 限额仍生效，客户端应明确呈现达到限额的错误。

视频保留 scrcpy H264，采用浏览器兼容 profile、RTP packetization-mode=1 与 90k 时钟；SPS/PPS 在关键帧前补齐。RTCP PLI/FIR 必须驱动设备请求新视频配置/关键帧并验证恢复。音频使用 scrcpy Opus 48kHz 双声道直接 RTP，拒绝把 PCM 当 Opus。旧路径继续 PCM。

## 最低验证

先验证 SDP/JSON 行边界、H264 配置与时间戳、Opus 头、取消和晚到处理；再构建 Windows 插件、浏览器真实 ICE/音视频、受控媒体与释放；更新当前预览时核验宿主 PID 不变及公开贡献出现。真机画面、音频、控制、局域网、防火墙和端到端延迟分别记录，未经实际验证不计通过。
