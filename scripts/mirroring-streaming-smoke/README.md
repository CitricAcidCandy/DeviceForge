# 投屏直播独立功能验收

本目录独占直播功能测试，不修改生产或既有录像验收。原生夹具为标准库 Rust 程序 `fake-adb.rs` 与 `socket_server.rs`，由独立 `rustc` 编译，不占共享 Cargo；正式宿主和投屏插件仅消费主代理明确冻结的构建。文档和夹具使用 UTF-8。

固定协议为 scrcpy-server 3.3.1、ADB forward、H264 Annex B、PCM 16 位小端双声道 48000 Hz。媒体分别经本机 TCP 转发，输入通过控制 socket；独立黄金 `golden.mjs` 不导入生产编码器。夹具按计划拆写首部和媒体包，记录每次 argv、直接 PID、连接代次、发送原件及控制原字节。远端目录、PID 身份、端口映射以持久状态文件模拟，必须经清理命令明确删除；本地 ADB 退出不会自动删除模拟远端资源。

`self-check.mjs` 只验证独立夹具可用；不能计为未完成生产通过。真实服务入口 `mirroring-streaming-smoke.mjs` 需主代理冻结后运行，覆盖 HTTP/MCP、实际前端工厂、原字节、取消、卸载、旧代次、断线重连与清理。每轮在独立 `artifacts` 目录保存输入身份、宿主日志、TCP 原件和报告，首次失败保留。

独立资格命令为 `node scripts/mirroring-streaming-smoke/self-check.mjs --tool=夹具绝对路径`。实际服务命令为 `node scripts/mirroring-streaming-smoke.mjs --frozen-input=主代理冻结目录 --tool=夹具绝对路径 --probe=OS探针绝对路径`，可另选 `--profile=debug` 或 `--profile=release`。冻结目录必须包含实际 `apk-server.exe`、`deviceforge-mirroring-plugin.exe` 与清单。调用前同时冻结实际前端导入闭包，不能用旧程序解释新协议。

第一批驱动为四会话：实际前端原字节/控制后取消、MCP控制与在途卸载、新插件代次内首连接断线及第二连接恢复、宿主关闭。重连不自动重播控制，旧连接 epoch 的控制虽然通用输入可先给接收回执，处理器须终态失败且真实 socket 零写。所有工具在独立门闩停留，OS探针取得直接工具和父插件本次句柄后才继续；短 ADB 调用和常驻服务均计入，不能用退出后 PID 查询推定历史进程已结束。

合成 H264 包只用于编码字段和转发边界，不证明完整解码、视频可播放、画质或真机 FPS；PCM 原件用于小端样本/字节传输，不证明真实设备音频。ADB、scrcpy、设备、浏览器播放、跨平台与正式 TGZ/npx 分发各自待验。性能测试按用户决定延后全部业务开发完成。

## 早期证据

2026-10-13独立 `rustc` 与夹具自检已实际退出0，最新已验原件为 `artifacts/mirroring-streaming-fixture-self-check-b6b3ebb4-7140-47ee-8e2f-e41e2b4e000a/report.json`，三检查涵盖黄金媒体/控制、六进程退出、持久模拟清理与 DFML 分帧。该原件早于随后服务进程也采用门闩的窄修，门闩窄修暂未重新运行。

早期新服务驱动所有 `.mjs` 曾通过 `node --check`，当时执行器拒绝导致宿主与插件未冻结。该停止状态已由下述修正版实际服务证据取代，不能使用历史录像程序解释新协议。

## 新功能负例与最新资格

当前原生夹具由后端在有效 MSVC 环境重编，最后严格 PID 门闩版自检为 `a593af4a-19d8-437f-97c7-1f7298eb6338`。随后独立黄金加入 9225 字节视频包，跨 8192 块的新版自检为 `artifacts/mirroring-streaming-fixture-self-check-b08682d9-fad8-49c3-912b-d1fcb319393d/report.json`，实际退出0、三检查通过；本轮未重复编译相同 Rust 输入。

普通服务可另传 `--plugin-input=冻结包mirroring目录`，宿主仍从 `--frozen-input` 根读取。实际前端 feature 与 API client 相对导入闭包逐文件复制到服务 snapshot，并对源文件和副本独立核对 SHA；运行时导入副本，不能以事后源文件替代。

两项独立资源负例入口为 `node scripts/mirroring-streaming-smoke/resource-failure.mjs --case=missing-pid或foreign-forward`，同时传普通服务使用的冻结目录、plugin-input、tool、probe 参数。每场景独立宿主与数据目录：缺 PID 必须保留远端目录并报告清理失败；已知端口映射转成外来 SCID 必须不调用 remove、不删除外来 forward。两者均要求卸载 HTTP409/cleanup_failed、draining、贡献撤销和重载 HTTP409/conflict。直接工具与父插件退出不能覆盖模拟远端残留；副本、日志和原件保留。

前三轮普通服务首失败保留：b624701e 清单模型误判导致零宿主；f991f1ec 首次真实会话提前终态而驱动未保存业务错误；0f72d0fb 加入早终态保存后证实 `直播打开操作或产物输入无效`，零 ADB 工具、宿主正常退出。0f72d0fb 原 SessionInfo 已写入报告；后端录像贡献的公共空产物授权误拒绝属于生产契约阻断，此阻断由下述新冻结修复，未通过关闭录像 outputs 绕过。

## 2026-10-13 修正版三独立实服

主代理冻结输入为 `artifacts/mirroring-live-debug-frozen-bcd0487a-d92f-4199-9816-f7ed140ba112`。正常报告 `artifacts/mirroring-streaming-service-debug-fb13d2c0-73c1-40d6-81bc-a7f32c252e49/report.json` 为六检查、四会话、四十个工具通过；覆盖实际前端冻结副本消费跨块黄金H264/PCM、四种控制、恢复无重放、EOF保留直播、MCP拆块输入、卸载与代次历史、重连与旧epoch零写、宿主关闭、日志关联及输入前后身份。全部直接工具和父插件由原始OS句柄确认退出，父插件与宿主退出0、监听释放；普通驱动Node外壳退出码未由跨REPL句柄独立读取，不扩大为该外壳退出码证据。

缺PID报告为 `artifacts/mirroring-streaming-resource-missing-pid-b2dfb218-7d13-4206-a5d5-6901b66ac781/report.json`，三检查、八工具通过且驱动退出0。外来forward报告为 `artifacts/mirroring-streaming-resource-foreign-forward-e06098ad-a25a-49d2-9178-53cbed624bd2/report.json`，三检查、六工具通过且驱动退出0。两轮各自独立宿主和数据根，严格验证Failed清理、残留保护、卸载409与重载409、贡献撤销和直接OS退出。

正常轮首次新包报告 `artifacts/mirroring-streaming-service-debug-0bfabb59-c97a-4c1b-a8a8-b0c903b5df55/report.json` 保留失败：本地ADB被生产终止时可截断夹具临终标记写入。现驱动记录这些标记原值，要求持有原始句柄的OS探针确认server实际退出与 `test_kill=false`，从而确认该进程socket句柄释放；不把空标记解释为优雅关闭。旧epoch零写比较已退出server的稳定 `control.bin`，不能依赖被截断的 `control.final.bin`。四个修改驱动语法实际退出0，原件为 `artifacts/mirroring-streaming-driver-cleanup-syntax-20261013.json`。

以上仍不证明真实ADB/scrcpy、真机、完整H264播放、浏览器解码、远端进程树、跨平台、正式分发或性能；性能测试继续延后业务完成。
