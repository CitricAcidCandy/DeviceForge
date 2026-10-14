# 安卓安装与截图浏览器验收

本目录是独立验收驱动，不是产品页面。驱动加载已经构建的生产 `frontend/dist/assets/plugin-host.js`，通过公开 SDK API2 的 `HostContext.artifacts`、`HostContext.devices` 消费真实 HTTP 宿主；设备提供者的声明版本为 API3。浏览器插件不导入宿主私有模块。

入口为 `scripts/android-artifacts-browser-smoke.mjs`。必须显式传入主代理已经编译的真实 `--tool-binary`，并可用 `--release` 选择后端 release 二进制；脚本不执行 Cargo、npm 或服务构建。安装包是固定 Stored ZIP，仅作为受控上传输入，不能据此宣称 APK 可在真机安装。

验收范围包括：

- 无插件时目录没有 Android 提供者；加载真实 native 插件后核对 10 个 operations、9 个设备能力、API3 定义、安装与截图预算、产物输入指针和 outputs 声明。
- 浏览器通过 `artifacts.upload` 上传 APK，调用 `devices.invoke` 的 `app.install@1`，观察真实 Job 终态并检查工具 marker 记录了本次私有暂存路径；公开 Job 不暴露本机路径。
- 调用 `screenshot@1`，读取宿主生成的唯一 `screenshot.png` 产物并以 SHA256 与真实 fixture `pixel.png` 逐字节比较；同时核对产物下载 HTTP 日志 ID。
- 覆盖真实 HTTP 错误、坏 UUID、截图额外字段、设备失败 Job、缺失产物 404，以及 MCP `tools/call` 对同一 Job 与完整事件历史的回执关联。截图下载使用公开 HTTP 原字节端口。
- 覆盖预取消零传输、插件/浏览器作用域撤销后的旧引用零传输、卸载后历史 Job 与产物仍可读取、新 generation 不接受旧代设备动作。

报告会记录 Rust 与 Edge 的 OS exit/close、端口重新绑定、输入清单、临时部署副本、HTTP/MCP 日志摘要和未验证边界。未验证项包括真机/ADB daemon、真实 APK 可安装性、LAN/npx、生产性能、截图视觉质量以及取消对外部设备副作用的停止。

本次独立 Rust 进程通过 `APK_MCP_HOSTS`、`APK_MCP_ORIGINS` 只允许本次回环上游地址；验收桥把浏览器 MCP 请求的 Origin 改为该上游地址，继续保留真实状态、响应头和原字节。此链路验证同一真实宿主的 MCP Job/事件消费，不代表任意浏览器来源或产品部署的来源授权已经验收，生产来源校验保持启用。

## 运行参数

在项目根目录执行；工具须由主代理预先编译 `backend/crates/infrastructure/src/device_artifacts/fixtures/device-tool.rs`，其 `shell_words.rs`、`probe.rs` 与 `pixel.png` 均纳入输入身份清单。

```powershell
node scripts/android-artifacts-browser-smoke.mjs --tool-binary G:/Rust/DeviceForge/artifacts/android-artifacts-browser-tool.exe
node scripts/android-artifacts-browser-smoke.mjs --release --tool-binary G:/Rust/DeviceForge/artifacts/android-artifacts-browser-tool.exe
```

可用 `--source-directory <绝对路径>` 指向冻结插件元数据目录；实际插件二进制仍按 debug/release 从 `backend/target` 读取。`DEVICEFORGE_TEST_BROWSER` 可指定 Edge/Chrome 二进制；脚本只关闭自己创建的进程，不清理占用端口的其他 PID。

## 文件职责

| 文件                      | 职责                                              |
| ------------------------- | ------------------------------------------------- |
| 根入口                    | 参数、输入摘要、独立Rust/Edge、资源终态与报告     |
| `deployment.mjs`          | 源声明校验、实际native副本、CLI物化、工具旁置配置 |
| `fixtures.mjs`            | 固定APK/PNG及小型浏览器TGZ生成                    |
| `bridge.mjs`              | 生产资源只读路由、原字节HTTP/MCP转发及日志证据    |
| `harness.mjs`             | 生产runtime装配、面板目标、逐步报告与释放         |
| `evidence.mjs`            | 浏览器断言、真实HTTP/MCP日志、SHA256和有限Job观测 |
| `scenarios.mjs`           | 安装/截图、上传下载、真实错误与双端历史           |
| `lifecycle-scenarios.mjs` | 预取消、挂载/插件/runtime撤销与提供者新代隔离     |

取消目前验证预取消、已经撤销引用和消费资格；工具没有可靠在途门闩，不用固定 sleep 推断安装正在运行。真实在途工具取消和宿主资源排空由独立后端服务/协议测试另证。
