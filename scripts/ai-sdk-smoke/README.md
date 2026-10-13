# AI SDK 独立真实宿主验收

本目录只负责冻结输入和公开 HTTP/MCP、前端工厂、真实 OS 退出验收。执行入口不会运行 Cargo、安装依赖或下载 SDK，也不会从活跃构建目录回退。模拟 CLI 使用 Rust 标准库与 Windows 原生接口，官方 SDK 保持完整真实包树。

## 冻结和执行

先用 `node scripts/ai-sdk-smoke/prepare-fixture.mjs` 独立编译原生模拟 CLI，再以三个绝对路径准备材料：

```powershell
node scripts/ai-sdk-smoke/prepare-inputs.mjs --sdk-package=<官方SDK完整包目录> --fixture-root=<原生CLI编译产物目录> --probe-binary=<OS探针程序>
```

由主代理提供已修插件完整冻结根和宿主二进制，用 `stage-binaries.mjs --frozen-input=<准备材料目录> --plugin-snapshot=<插件冻结根>` 与 `--host-binary=<宿主程序>` 分别接入。该工具拒绝覆盖已冻结成员。API 类型重新生成后应准备新的前端副本；不得混用旧生成输入。

完整冻结根必须包含 `apk-server.exe`、`plugin/deviceforge-ai-sdk-plugin.exe`、manifest、worker 五个 JS、worker 来源、`sdk-package` 完整包树、`node.exe`、`process-probe.exe`、`sdk-cli.exe`、夹具三源码和编译报告、前端传递依赖实际副本与 `source-manifest.json`。运行前后逐件比较 SHA256 和字节数。插件旁置配置固定在 exe 同目录，不使用替换 worker 的环境入口。

```powershell
node scripts/ai-sdk-smoke.mjs --frozen-input=<完整冻结根>
node scripts/ai-sdk-smoke.mjs --frozen-input=<完整冻结根> --frontend-only
```

每次执行创建新的 `artifacts/ai-sdk-service-<profile>-<UUID>`，包含完整输入副本、公开输出原件、原生 CLI 的 argv/prompt/EOF、各角色 PID 与创建时间、稳定 OS 句柄退出、宿主日志及最终 `report.json`。失败原件保留，失败清理不得算成功。

## 判定范围

- 普通协议 4 六贡献与协议 5 单实时贡献动态注册；HTTP/MCP 共享 Job、四轮助手、线程获取和关闭、真实版本及 SDK 加载资格。
- 十个独立黄金事件、中文 UTF-8 分片、超过 8192 字节的完整正文快照；提供者候选期间禁止公开 `turn.completed` 和最终成功。
- 非零退出、缺少完整结束、完成后迟到事件、显式取消、未知/跨项目/关闭/uncertain 线程拒绝；热卸载、代际更新和旧输出保留。
- 实际 `createApiClient`、`createHttpAiSdk` 和 `createHttpAiSdkStreaming` 消费冻结 TS 副本；普通封套、候选、同 ID 游标和历史恢复不重新提交。
- 每个取得句柄的 CLI、两代后代、Node、监督、代理以及直接父进程真实退出；正常宿主关闭、监听释放、临时目录清空与日志 ID 配对。

模拟轮次可能令隔离运行状态的 `model_verified` 为真，最终报告仍固定 `real_model_verified:false`。这批证据不代表真实模型、真实 Codex CLI、账号、浏览器呈现、跨平台、正式分发、真机或性能验收。短寿命 Node 版本与 SDK 探测不泛称已取得额外稳定 OS 句柄。MCP 目录通知由主代理的独立长连接验收覆盖，本入口保留公开 POST 元数据合同。
