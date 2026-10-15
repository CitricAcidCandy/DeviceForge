# 投屏 WebRTC 独立联调

本脚本只启动本次隔离宿主、独立假 ADB 和 Edge 探针，不接触当前预览宿主。插件使用同一 `mirroring` ID 同时公开旧 `open` 与新 `open_webrtc`。浏览器经本次 Vite 代理访问隔离 HTTP，会在真实 `RTCPeerConnection` 上验证 ICE、视频轨道、解码帧、Opus RTP、可靠控制通道和释放清理。媒体由 FFmpeg 生成 H264 Annex B 与 Opus 包；假 ADB 按当前设备脚本精确核对进程身份与远端归属。

先以独立 `rustc` 构建夹具，不占用后端 Cargo：

```powershell
rustc --edition 2021 scripts/mirroring-webrtc-smoke/fake-adb.rs -o artifacts/webrtc-fake-adb.exe
```

然后提供主代理冻结的宿主目录、插件目录和夹具路径：

```powershell
node scripts/mirroring-webrtc-smoke.mjs --frozen-input=宿主冻结目录 --plugin-input=插件冻结目录 --tool=artifacts/webrtc-fake-adb.exe
```

冻结宿主目录需有 `apk-server.exe`，插件目录需有 `manifest.json` 和 `deviceforge-mirroring-plugin.exe`。可传 `--browser=Edge绝对路径`。单独验证浏览器/CDP 可用：`node frontend/scripts/webrtc-browser-probe.ts --browser-smoke`。每轮在 `artifacts/mirroring-webrtc-smoke-*` 留存输入 SHA、媒体、隔离服务与浏览器报告；失败保留，不把早期版本通过外推到新版本。

本轮只证明 Windows 本机假设备和真实 Edge。真机画面、音频播放、局域网防火墙、NAT/TURN、正式分发、持续运行和延迟另行验收。

## 2026-10-15 隔离验收

严格候选 SHA256 为 `160314F35A29990653C3B2BD873C8191A3F24A61BE1B107C8A36D5CC655F99C6`。最终报告 `artifacts/mirroring-webrtc-smoke-2d4646ba-1da1-49d0-9b43-907c288f2702/report.json` 为四项通过，驱动退出 0。Edge 实际解码 64×64 视频 15 帧、零丢帧，选中 UDP host 候选对，收到 64 个 Opus 包、32160 个解码样本；按键 down/up 的设备原字节顺序一致，并收到两次视频重置。会话释放后返回 404 的移除证据与假设备目录、进程身份及 forward 清理一并核对；未应答协商与旧 `open` 另保留真实 `finished/cleanup=complete/process_exited=true` 终态。自有宿主正常退出、监听端口释放，27 个夹具进程 PID 均已退出，冻结输入摘要保持一致。

早期报告 `artifacts/mirroring-webrtc-smoke-774f6ab1-7409-4eb0-9608-05fc3d246b55/report.json` 保留失败：旧 `open` 仅发出 DFML 元数据即被取消，假 ADB 的 `mkdir` 被截断，随后夹具清理读取尚不存在的目录身份而失败。兼容用例现等待设备媒体套接字实际发送后取消，证明已开始传输的旧会话仍可清理；该结果不覆盖准备期间取消。浏览器探针仅在自身 HTTP 服务器支持 `closeAllConnections` 时调用，并使用本次 Edge PID 回收测试进程树。

用户随后明确首期不提供音频。最终无声候选 SHA256 为 `C8F9A752062FEE3241E7956BDDEAF58CFFD16FEEF07B2AF544770636B9FD8A87`；报告 `artifacts/mirroring-webrtc-smoke-15925553-8c88-489d-9829-6bd3b4bbe235/report.json` 四项通过，驱动退出 0。Edge 解码 64×64 视频 15 帧、零丢帧，实际使用 UDP，未建立音轨；控制原字节、会话移除、未应答取消、旧会话清理与冻结输入稳定均通过，自有宿主和 27 个夹具进程已退出。前述带音频报告仅保留历史证据，不代表最终候选提供音频。
