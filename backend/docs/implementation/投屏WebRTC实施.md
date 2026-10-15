# 投屏 WebRTC 实施

## 架构裁定

模式为 architecture-first，使用 SDD 与定点行为验证。首期目标为浏览器经 WebRTC 传输实时画面并保留可靠设备控制、取消和释放；音频暂不提供，兼容模式继续保留原能力。当前 7031 宿主不得重启。影响范围仅投屏插件、前端消费与所属文档和验证工具，不修改宿主公开 SDK 或路由。

比较同 ID 增量贡献和独立插件：选择在原 mirroring 插件增加 `open_webrtc`，复用已验证的设备资源所有权，避免复制 ADB 清理逻辑。旧 `open`、录像和运行查询保持原合同。当前无活动会话，构建和独立验证后通过公开卸载、精确替换部署插件、重新加载完成更新；加载前核实清理完成，失败保留旧包以便恢复。宿主进程及二进制保持不变。

| 单元 | 负责 | 不负责 | 输入输出与副作用 |
| --- | --- | --- | --- |
| manifest、live 入口 | 新贡献声明及分流 | 媒体实现 | 原有会话 5 到对应执行器，无新增宿主 API |
| live/device | 固定部署工具、独占 ADB/scrcpy 资源、编码模式 | WebRTC 协商 | 参数到设备套接字；进程、文件和转发 |
| webrtc/signaling | 有界版本化 JSON 行 | 媒体缓冲 | 可靠会话字节到 SDP 与状态 |
| webrtc/peer | ICE、DTLS、SRTP、RTP 轨道及 RTCP | ADB 进程 | H264/Opus 原包到浏览器；UDP 套接字，关闭确认 |
| webrtc/reader | 保存分片包头与载荷进度、有界媒体读取 | 派生读取任务 | 设备 TCP 到完整包；Future 被取消后保持读取位置 |
| webrtc/mod | 原期限、取消、设备和 peer 清理 | 伪造连接恢复 | 会话到 Execution，清理失败保留 Failed |
| 前端 WebRTC 模型/适配 | 信令消费、PeerConnection、代次、释放 | 旧 DFML 解码 | SessionGateway 到远端 MediaStream |
| 媒体展示/页面 | video 绑定、音频播放和坐标控制 | 直接 HTTP、SDP 编解码 | 用户操作到业务用例，DOM 与播放资源 |

新增媒体路径按职责拆入 `plugins/mirroring/src/live/webrtc/`；现有设备模块只增加显式编码模式，不复制资源代码。前端独立 WebRTC 模型和适配，原 DFML 模型继续使用。设备所有权保持插件内部可见，不向公共 SDK 暴露平台实现。当前实现的边界为本机与可直连局域网，公网 NAT 穿透和 TURN 部署另行配置设计。

## 信令合同 1

贡献为 `plugin.mirroring.open_webrtc`，打开参数与旧 `open` 一致，使用协议 5、bounded_tail。一个会话仅一代协商，`epoch=1`，不自动重放旧控制或静默重连；连接失败须释放后重新打开。会话 stdout 为 UTF-8 JSON 行，每行不超过 65536 字节（含换行），允许跨会话块和 HTTP 页；输入也为相同有界 JSON 行，单会话仅接受一个 answer。

服务端输出 `{"version":1,"epoch":1,"type":"offer","sdp":"..."}`，等待 ICE 收集完成再发送完整 offer。客户端输入 `{"version":1,"epoch":1,"type":"answer","sdp":"..."}`，同样等待完整 ICE 收集，不使用 trickle ICE。双方只传最少 SDP 和状态，媒体不经过宿主 JSON 管道。信令收集与协商有独立超时且受原会话期限和取消约束。

服务端状态为 `{"version":1,"epoch":1,"type":"status","state":"connecting|streaming|audio_unavailable"}`。视频尺寸来自远端 video 实际解码尺寸；控制输入为 `{"version":1,"epoch":1,"type":"control","command":{旧控制对象}}`，最多 4096 字节且拒绝未知字段，允许 control=false 的会话完成信令但拒绝设备控制。现有可靠会话输入累计 1MiB 限额仍生效，客户端应明确呈现达到限额的错误。

### 控制通道补充

为避免每次触摸等待 HTTP 往返以及长期操作耗尽会话输入累计限额，插件 offer 同时声明可靠、有序的 DataChannel `deviceforge.control`。通道载荷使用上述 control JSON（UTF-8，含换行最多 4096 字节），保持版本、代次、控制权和严格字段校验；媒体不通过 DataChannel。浏览器只有通道 open 且媒体连接就绪后准入控制，单次发送前检查 bufferedAmount 不超过 65536 字节；超限明确返回背压错误，不自动重放。服务端控制入口使用有界队列，拒绝非法消息或积压溢出，结束时撤销回调并关闭通道。HTTP control 保留作为公开兼容入口；产品 WebRTC 操作不自动回退 HTTP，避免不确定提交后重复触摸。DataChannel 发送成功仅证明本地接受，不伪造服务端操作回执或请求日志 ID。

peer 模块负责 DataChannel 和有界输入，纯控制编码仍复用 live/model；前端服务适配负责通道监听、背压及撤销，模型只编排。新增验证包含控制关闭权限、通道未就绪、背压和释放后晚到消息。

视频保留 scrcpy H264，采用浏览器兼容 profile、RTP packetization-mode=1 与 90k 时钟；SPS/PPS 在关键帧前补齐。RTCP PLI/FIR 必须驱动设备请求新视频配置/关键帧并验证恢复。首期 WebRTC 不启动音频通道，避免设备端音频编码器兼容性影响视频投屏；旧路径继续 PCM。

ICE 收集及等待 answer 期间持续排空旧媒体，连接后重置视频并等待关键帧；沿用已验证的 SPS/PPS，收到新配置时重新校验 profile。媒体读取器保留半包进度，避免异步选择取消读取时丢字节或错位；不以丢弃读取任务代表资源已经回收。视频和音频的 RTCP 均需消费，控制队列溢出以粘性失败结束会话，不能丢失按键后继续报告成功。

## 最低验证

先验证 SDP/JSON 行边界、H264 配置与时间戳、Opus 头、取消和晚到处理；再构建 Windows 插件、浏览器真实 ICE/音视频、受控媒体与释放；更新当前预览时核验宿主 PID 不变及公开贡献出现。真机画面、音频、控制、局域网、防火墙和端到端延迟分别记录，未经实际验证不计通过。

## 本机热更新

根目录运行 `node scripts/mirroring-hot-update.mjs`，可通过 `--plugin=`、`--manifest=`、`--deployment=`、`--base-url=` 指向明确的本机预览部署。脚本只接受本机 HTTP 管理服务，要求无活动投屏、插件可卸载且清理正常；备份旧二进制和部署清单，保留工具配置及入口参数，先公开卸载再替换并加载。每个阶段核验原宿主监听 PID，加载后核新旧贡献与健康状态；失败时仅在没有排空或清理失败的前提下恢复本次备份。报告和日志 ID 写入本次 artifacts，不写入业务日志或源码。

当前预览使用固定 CLI 部署，不通过在线包删除接口更新，也不调用宿主 shutdown。脚本不更新运行中的浏览器模块；Vite 会提供新前端构建，已有页面需正常重载以切换新的播放实现。

## 2026-10-15 当前交付证据

- 当前首期只提供视频和可靠控制。即使调用方携带音频参数，WebRTC 执行入口也固定关闭设备音频；媒体页两种模式均不提供音频入口，旧兼容 API 合同保留。音频代码和早期合成 Opus 证据只作后续参考，不计首期音频交付。
- 机器在 17:08（Asia/Shanghai）发生重启，旧预览进程随系统结束。随后使用原启动脚本恢复原宿主，进程为 26340；两次插件热装卸期间该 PID 均保持不变，未调用宿主关闭接口。宿主 SHA256 仍为 `C2EA162225CB6645DB5EC6DA1C21AE86508B8CD61364C942D75C81B0E9711CD7`。
- 最终无声候选 SHA256 为 `C8F9A752062FEE3241E7956BDDEAF58CFFD16FEEF07B2AF544770636B9FD8A87`，热更新报告为 `artifacts/mirroring-hot-update-8f853dd1-29cc-4c13-9b0b-6c3ea30b59d3/report.json`。旧 `open` 与新 `open_webrtc` 均加载，清理失败标记为 false。
- 三星 SM_G991U 真实 Edge 验证报告为 `artifacts/webrtc-browser-1792057942938/report.json`：1280×576、15 个播放帧、4 个丢帧，RTP 解码 20 帧；实际 host/UDP 候选对，可靠通道三次控制本地接受，重置后仍有新增画面。释放后宿主记录返回 404、本地轨道 ended；404 不伪造 Finished 或 cleanup 字段。真实设备转发与本次独占远端目录检查为空，最终手机息屏。
- 最终插件格式、Clippy、24 项测试及 debug 构建通过；无声窄修前完整 workspace test/build 通过，原系统重启造成的 PDB 损坏失败日志保留。前端接口生成、7 项 WebRTC 定点测试通过，最终无声页架构及严格类型检查和构建通过；未运行前端全量测试。
- 最终无声隔离报告 `artifacts/mirroring-webrtc-smoke-15925553-8c88-489d-9829-6bd3b4bbe235/report.json` 四项通过且驱动退出 0，冻结候选摘要匹配：64×64、15 帧、0 丢帧、实际 UDP、无音轨、30 字节有序按键与两次重置；未应答取消和旧 open 均取得真实清理完成证据。通用服务默认与性能插件两模式、插件生命周期及合作取消三情形均退出 0，日志在 `backend/artifacts/mirroring-webrtc-gates`。
- 真实音频实验曾在 Android 11 的设备端 CCodec 配置时发生栈保护崩溃，原始证据保留在 `artifacts/webrtc-device-diagnostic*`；用户随后明确延期音频，不再继续该兼容研究。局域网、防火墙、NAT/TURN、持续运行及操作到画面的端到端延迟尚未验收，不以回环 RTT 代替延迟结论。
