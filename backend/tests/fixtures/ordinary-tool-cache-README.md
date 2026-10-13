# 工具清单缓存独立真实服务驱动

## 写集与执行归属

本批只新增 `backend/tests/ordinary-tool-cache-smoke.ts` 与本目录 `ordinary-tool-cache-source.ts`、`ordinary-tool-cache-evidence.ts`、`ordinary-tool-cache-cases.ts`、本说明。旧工具功能 22 检查/42 Jobs 驱动与公共辅助不修改。测试助理只编写并读取摘要，构建、严格类型检查和服务全部由主代理串行执行。本文件不表示任何命令已经运行或服务通过。

## 前置输入与准确命令

要求 Node.js 22.18 或更高版本（直接运行可擦除 TypeScript 与内置 `node:sqlite`），前端已经安装 TypeScript 5.9 和 `@types/node`。须先冻结后端缓存实现，再在 `backend` 目录构建真实宿主及工具插件；不需要构建任何安全工具，也不调用真实 SDK：

```powershell
cargo build -p apk-server -p deviceforge-tool-supply-plugin
cargo build --release -p apk-server -p deviceforge-tool-supply-plugin
```

构建包名应以当前 workspace 的公开 `Cargo.toml` 为准，实际需要的二进制分别为 `apk-server.exe` 和 `deviceforge-tool-supply-plugin.exe`（非 Windows 无后缀）。宿主和插件必须包含本轮新缓存实现，不能借记旧运行包。

在项目根目录由主代理执行严格静态检查（不启动宿主）：

```powershell
node frontend/node_modules/typescript/bin/tsc --noEmit --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --noUnusedLocals --noUnusedParameters --erasableSyntaxOnly --module NodeNext --moduleResolution NodeNext --target ES2022 --allowImportingTsExtensions --types node --typeRoots frontend/node_modules/@types backend/tests/ordinary-tool-cache-smoke.ts
```

随后在项目根目录执行服务：

```powershell
node backend/tests/ordinary-tool-cache-smoke.ts
node backend/tests/ordinary-tool-cache-smoke.ts --release
```

可加 `--bin-dir 绝对目录` 指向已构建且冻结的二进制，也可加 `--rounds 1..10`；每轮创建独立 `artifacts/ordinary-tool-cache-<模式>-<时间>-<UUID>`，不覆盖旧报告。默认每轮 HTTP/MCP 分别等待一次生产 `runtime_feature.status` 原 120000ms 自然到期，正常轮次至少约四分钟；不修改 manifest、不缩短插件预算、不增加业务重试。到期观察最多等待原预算加 15000ms 收口余量，普通任务仍使用既有 15 秒宿主查询辅助。

## 本批矩阵

HTTP/MCP 两种提交分别使用独立数据、安装、缓存和部署目录，各启动三个宿主代际。同 Job 始终经 HTTP v2 与 MCP 查询深比较；提交/查询/取消响应关联沿用公开辅助。

- live A：五操作来源元数据、双 runtime 顺序安装、不安装同功能 tool 与备用模块；ZIP、入口及托管状态原字节核验。
- 初代宿主正常关闭后重启：新 Job 503 回退 cache A，摘要与 A 相同、重复准备无下载，原缓存和安装字节不变。
- live B：清单和模块版本仍是 `1.0.0`，内容/归档变化导致清单摘要不同；本地动作为 repair，两模块确实换成 B，缓存封装更新。
- 新调用 cache B：catalog/plan/install/status/prepare 外层元数据、现有安装零下载；未知 status 为空，未知 prepare 精确业务失败。503、响应中断、JSON 与完整资格失败均只能请求一次配置来源。
- 清单缓存不等于离线安装：备用模块仍发起归档 GET；503 使 Job 失败，目标和事务不存在，不伪造离线成功。
- 缓存缺失：仅 status/catalog 成功降级，catalog 保留本地行；plan/install/prepare 失败。故障通过移出本轮快照实现，随后恢复原件，不改用户文件。
- 缓存损坏：status/catalog/prepare 硬失败，不吞成降级。仅本轮封装替换为合成损坏内容并记录摘要，finally 恢复原字节。
- 清单首块门闩后另一传输取消：原 Job cancelled、单 GET、连接释放、缓存与安装字节不变、插件仍 loaded/可调用。
- 清单首块门闩自然到期：无取消调用，原 Job failed 且错误为超时/期限到期，不能提前网络失败或回退成功；单 GET、连接释放、缓存/安装字节不变、插件继续可调用。
- 第三代仅恢复查询原成功/失败/取消任务：终态与输入/结果/错误摘要不变，无来源读取、无新增任务。宿主退出后只读 SQLite 独立核对每个 Job；提交日志 ID、任务/插件调用日志及不同调用身份交叉核验。

## 原件与证据边界

保留独立报告、源清单/文本ZIP/入口、A/B 缓存封装副本、部署、安装状态、SQLite 和宿主受控 JSONL 日志。报告只写正文/错误摘要与字节数，不记录令牌、请求头或任意原始错误/插件标准错误。合成源只接收 GET，不触及真实外部源。失败不删除现场，finally 收口来源和宿主；只有 shutdown accepted、exit0、非强杀、PID 消失、端口释放全部满足才记录正常退出。

身份同时包括当前插件源码、公开配置/契约、驱动/共享辅助、预构建二进制以及部署副本前后摘要；源码/输入变化使本轮失败，不能接受后端自报 passed 作为独立证据。

当前后端 `cache.rs` 定义 canonical 为 `serde_json::to_vec(Manifest)`：固定 Rust 字段声明顺序、默认/null 字段与模块数组顺序。驱动同时保留原 HTTP JSON 哈希 `response_body_sha256`，并按同一字段顺序独立重算 canonical 摘要，核对公开 `manifest_sha256`；独立比较 live/cache、A/B 摘要、封装对应摘要、固定规范 URL 身份与模块输入。报告标记 `independent_canonical_recomputed=true`，不把原 HTTP JSON 哈希误当作 `manifest_sha256`。

本轮新增并已纳入服务矩阵：`manifest_cache_enabled=false` 时仅查询可降级且不创建缓存目录；`local_manifest` 不读取远端且不创建缓存目录。仍未覆盖：缓存 IO/Busy、写入/flush/sync/提交失败与清理失败、切换来源身份、并发原子读取、旧 install 锁序、DNS/TLS/正文超限、模块下载阶段自然到期、真实来源/SDK/跨平台/npx。不能借记旧 22/42、库测试或其它二进制的证据补齐这些缺口。
