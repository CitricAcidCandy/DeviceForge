# 投屏单控制者联调

本驱动启动独立随机端口宿主，加载冻结投屏插件，通过真实浏览器、前端工厂、HTTP 信令与 WebRTC 数据通道连接同一合成设备的三个会话。覆盖申请、拒绝、同意移交、主控抢回、只读拒绝、旧代输入零字节、设备剪贴板仅当前控制者收到，以及媒体/控制独立资源退出与卸载。

`fake-adb.rs` 独立实现多远端目录、精确 scid 转发及 `video=false` 控制连接；不替换现有假工具。`socket_server.rs` 发送实际 H264 帧并记录控制原字节，测试辅助入口注入 scrcpy 设备剪贴板原帧。`browser.mjs` 直接连接隔离后端，不经过 Vite API 代理。

先使用 `rustc --edition 2024 scripts/mirroring-ownership-smoke/fake-adb.rs -o artifacts/mirroring-ownership-fake-adb.exe` 构建夹具，再运行：

```powershell
node scripts/mirroring-ownership-smoke.mjs --frozen-input=<宿主冻结目录> --plugin-input=<插件冻结目录> --tool=artifacts/mirroring-ownership-fake-adb.exe
```

可通过 `--browser=<浏览器程序>` 指定 Edge；服务版本默认3.3.1，验证新版时传 `--server-version=3.3.4`。夹具从固定计划文件独立读取期望版本，并精确核对启动、就绪及清理身份，不从生产命令推断期望。报告和输入身份保存在本次 `artifacts/mirroring-ownership-smoke-*`，失败报告保留。驱动不接触正在运行的 7031，不连接真实设备；合成回包不是安卓原生菜单操作验收。本机浏览器的主控身份、真实多人局域网延迟与非主控拒绝分开记录。
