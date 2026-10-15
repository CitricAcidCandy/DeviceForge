# 投屏直播消费

## WebRTC 低延迟路径

`createHttpWebRtcMirroring` 通过现有会话网关打开 `plugin.mirroring.open_webrtc`。模型按 UTF-8 JSON 行消费信令，跨块、跨页组装服务端 offer，等待本机 ICE 完成后按每次最多 8192 字节发送 answer。`open` 在 answer 收据、媒体连接、视频轨和启用控制时的可靠有序 `deviceforge.control` 通道就绪后返回。服务端状态与媒体连接失败分别报告；连接断开超过 5 秒会释放会话。

首期媒体页不提供音频，WebRTC 和兼容模式均以 `audio:false` 打开，画面保持静音。WebRTC 只接收视频远端轨；控制在 DataChannel 上发送 UTF-8 JSON 行。该发送成功只表示浏览器本地已排队，不代表设备执行或服务端收据。背压、取消、释放清理失败保留明确错误。旧 `plugin.mirroring.open`、DFML/WebCodecs 和公开 `host.mirroring.stream` v1 保留原 API 音频能力；媒体页可手动选择兼容模式。

WebRTC 释放会先停止本地媒体，再等待服务端终态。服务端清理成功后可能回收会话记录，因此释放或随后查询返回 404 时会清空本地身份；返回数据保留已观察的真实终态，若未观察终态则保留原会话观测，不补造 `finished` 或清理完成证据。重复释放共用一次提交，销毁与读取失败的同步回调也不会重复发起释放。

## 当前目录结构

2026-10-14按用户最新约束采用 Ant Design Pro 风格的功能组织。此前 domain/application/infrastructure/ui 方案已被覆盖，不再作为当前目录约束。根 `index.ts` 保留核心公开API且不加载TSX，目录仅按实际职责创建。

- `models/`：用例、状态、订阅、轮询与会话控制；HTTP工厂在此组合注入的服务。
- `services/`：网关、归档IO、字节解码与浏览器适配，不反向引用models。
- `utils/`：纯规则、转换、结果验证和计算，不依赖models、services或components。
- `types/`：业务模型与端口类型；保留已有共享契约类型。

## 文件职责

| 文件 | 职责 |
| --- | --- |
| `types.ts` | 投屏业务输入、控制命令、DFML 包与消费快照 |
| `framing.ts` | 24 字节包头、跨输出块重组、4MiB 载荷上限与配置 JSON 校验 |
| `stream.ts` | 重连代次、画面/SPS/PPS/音频前置配置与 PCM 对齐规则 |
| `rules.ts` | 公开会话响应、设备参数、UTF-8 控制边界和日志保留 |
| `state.ts` | 请求所有权、取消、输入不确定性、订阅及旧代结果拒绝 |
| `index.ts` | 可注入会话网关、HTTP 工厂和无页面用例编排 |
| `h264.ts` | Annex B SPS 到实际 `avc1` 配置、关键帧配置前缀 |
| `video.ts` | 原生 WebCodecs 解码、可注入环境、有界队列与关键帧等待 |
| `audio.ts` | PCM16 双声道转换和注入 AudioContext 的有界播放队列 |
| `browser-sink.ts` | 按包路由至视频与可选音频解码，重连时撤销旧配置 |

## 使用边界

`createHttpMirroringStreaming(client, options)` 返回 `refreshDefinitions/open/resume/readOutput/readPackets/pollOutput/sendControl/eof/cancel/release/snapshot/subscribe/dispose`。`sink.packet(packet, signal)` 可用于浏览器解码或无界面消费；`readPackets` 只返回本次完成包的原字节与元数据，不积累全部媒体历史。默认没有 sink 也可由调用方使用公开媒体批次自行播放。

`readOutput/pollOutput` 的计数消费与 `readPackets` 的媒体消费共用同一游标，只能选择一个消费者读取当前页。已读取的数据不会因切换方法重放。每批最多 100 个 8192 字节输出块；完成媒体原字节不超过 4MiB 加 819200 字节，完成包最多 32768 个。快照不保存这些媒体原字节。

先刷新目录并确认 `plugin.mirroring.open`，打开后读取输出。每次只允许一个输出消费；先取消并等待已有轮询结束，再恢复。`resume(id)` 恢复同一已选会话时保留游标与未完整包；选择其他会话从零读取，不接受任意帧中间游标。网络失败不重开设备会话、不重放控制。媒体已开始交付后取消或解码失败，会标记该消费不可重放，要求显式重开；新 open 不自动取消服务器上的旧会话，需要明确调用 cancel 管理旧会话资源。

控制在已观察本代 `streaming` 状态后允许发送，门面自动添加当前 `epoch`。输入收据只证明后端接受控制队列，不能证明设备执行。收据失败后控制状态为不确定，不自动重发。EOF 只关闭控制输入，媒体继续读取。取消返回 Stopping 不等价资源已清理；持续读取到 Finished 的 completion 才能判断后端证据。

`release` 调用服务端释放接口并查询清理终态；确认清理完成或记录已不存在后清空本地会话，清理失败保留会话身份与日志。释放等待上限为15秒，取消调用方等待不撤销已发起的释放，重复调用共用一次提交；超时须重新查询服务端状态。产品页面离开活动路由时撤销打开等待、画面读取和控制队列并发起释放，迟到的打开结果补发释放，运行实例关闭也调用释放。HTTP释放请求启用 `keepalive`，供正常关页时继续发送；浏览器崩溃或网络中断仍可能阻止请求送达。服务端202仅表示已接收释放请求；请求中断后后端仍负责完成已登记的资源监督与记录回收。

`createBrowserMirroringSink` 需要宿主提供 `videoOutput(frame)`。回调必须同步消费或复制画面，返回后 VideoFrame 会关闭；未消费/旧代帧也关闭。可选 AudioContext 由宿主在用户交互中启动并拥有，sink 只回收自己创建的音源，不关闭共享上下文。浏览器不支持 H264 时明确拒绝，不自动降级为假画面。

`runtime.mirroringStreaming` 已装配；插件通过现有 `context.extensions.callService('host.mirroring.stream', '1', input, signal)` 调用公开服务。`action:'packets'` 返回本次媒体批次，视频/音频字节映射为 JSON 数组。宿主可在 runtime 构造时注入 `mirroringSink`，插件服务不接受替换 sink 或任意回调字段，插件可以自行消费媒体包创建自己的播放器。

合同详见 [投屏直播消费契约](../../../docs/contracts/投屏直播消费契约.md)。功能测试与真实性分开记录，性能测试按用户决定延后全部业务完成后执行。
