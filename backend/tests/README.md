# 三个普通插件的真实服务验收

本批写集仅为本目录，当前驱动冻结给主代理执行，不修改生产、前端或根记录。`ordinary-business-smoke.ts` 启动预构建的真实 Rust 宿主和 settings、ai-assistant、tool-supply 三个插件，直接调用 HTTP v2 与 MCP；驱动不调用 Cargo、rustc、旧工程或其他业务。所有文件为 UTF-8。主代理将本批交付及实际结果同步至根 todo.md。

## 主代理构建与运行

要求 Node.js 24.14 或兼容的原生 TypeScript 类型剥离环境。先冻结生产源码和清单，再在 `G:/Rust/DeviceForge/backend` 串行完成构建；以下命令本批测试助理未执行：

```powershell
cargo build -p apk-server -p deviceforge-settings-plugin -p deviceforge-ai-assistant-plugin -p deviceforge-tool-supply-plugin --bins
New-Item -ItemType Directory -Force -Path target/test-fixtures | Out-Null
rustc --edition=2024 tests/fixtures/ai-cli-fixture.rs -o target/test-fixtures/ai-cli-fixture.exe
node tests/ordinary-business-smoke.ts
```

基础矩阵通过并冻结输入后，独立开启扩展矩阵；多轮执行均使用新目录，失败即停止，不覆盖上轮：

```powershell
node tests/ordinary-business-smoke.ts --extended
node tests/ordinary-business-smoke.ts --extended --rounds 2
```

Linux/macOS 的 rustc 输出名去掉 `.exe`。发布验证需要主代理先构建同样四个二进制的 `--release`，再为驱动加 `--release`；夹具路径仍默认为 `target/test-fixtures/ai-cli-fixture` 加当前平台后缀。自定义构建目录用 `--bin-dir <目录>`，专用夹具用 `--ai-fixture <路径>`；没有二进制时保留失败报告并退出 1，不自动构建。宿主与三个插件必须来自当前同一冻结批次，SHA256 身份不能代替构建来源证明。

## 矩阵

| 范围 | 默认基础矩阵 | `--extended` 增量 |
| --- | --- | --- |
| settings | list/get/set/delete/import，显式 null，用户/工作区分离，旧 CAS 失败原件不变，并发两个插件进程仅一个胜出 | 远端读取并备份、远端保存、网络失败回退、保存失败无损、过期 CAS 不发送请求、远端已提交但本地冲突如实返回、在途取消释放连接 |
| AI | runtime.status，首次 cli.turn 建归属，session.get，跨项目/未知线程拒绝且不启动 CLI，卸载重载后恢复，UUID 大小写归一，cli.single，session.close 及关闭后拒绝 | 开始门闩后 MCP 取消，实际 PID 消失，uncertain 持久化并拒绝重放 |
| tool-supply | catalog/plan，真实 SHA256/ZIP 安装，安装状态与入口原字节，current 不再下载，remove 与重复移除 | 错误 SHA256、无效 ZIP、越界成员、缺失入口保留原版本并清理事务；下载首块后取消；在途卸载取消、操作撤销与重载；成功升级 |
| 宿主 | 三插件独立部署，HTTP v2 log_id 与响应头一致，MCP `_meta` 关联，每个终态 Job 由 HTTP/MCP 读到同一实体，最终卸载，正常 shutdown/exit0/端口重新绑定 | 共用相同验收要求 |

AI 没有 `session.create` 操作：首次 `cli.turn` 的合成 JSON 事件返回原生线程 ID，插件据此登记归属。当前生产契约均已存在，无需新增操作或放宽生产输入校验。若生产清单继续修改，主代理重建后执行；不得凭旧二进制通过认定当前源码通过。

## 合成 CLI、开始门闩与固定输出

`fixtures/ai-cli-fixture.rs` 是无外部依赖的普通假 CLI，不连接模型，也不构建或执行安全工具。驱动复制已构建夹具，部署 AI 配置为 `executable=<本轮夹具绝对路径>`、`args=["--fixture"]`、`environment={}` 和两个合成项目目录。首次 argv 必须为 `exec --json --fixture -`，恢复必须为 `exec resume --json <规范小写UUID> --fixture -`。

每次调用分配 `call-01` 等目录，只接受 `设备工坊合成提示/` 开头且小于 256 字节的输入。标准输入只记录长度，不记录正文；argv 在限定协议形态校验后写入 `argv.bin`，并记录 PID 与宿主令牌是否泄漏的布尔值。`ready.tmp` 原子重命名为 `ready` 表示输入读取及证据准备完成，取消必须等此门闩。

驱动预写 `stdout-N` 的固定 `thread.started`、`item.completed/agent_message`、`turn.completed` JSON 行，以及 `code-N=0`；写 `release-N` 才放行。正常轮次写 `normal-exit=0` 并核验 PID 消失。取消轮次不写 release，核验工具被实际回收；45 秒夹具看门狗仅防止驱动异常遗留，不能作为正常取消证据。工具包仅含 `bundle/entry.txt` 文本，固定安装到本轮专用目录，不把文本包宣称为真实可用工具。

`fixtures/six-business-support.ts` 已修为 v2 封套、MCP 日志关联和共享 Job，取消了内部 rustc 构建入口，补实际进程退出及端口释放。旧 `six-tool.rs` 不在本驱动读取、构建或执行范围，避免其原始 stdin 持久化与其他业务行为混入当前验收。

## 证据与冻结边界

每轮保存在根 `artifacts/ordinary-business-<构建模式>-<时间>-<UUID>/report.json`，每项结束即时刷新，失败目录完整保留；不自动删除、不覆盖、不自动重试业务。报告包含源码/清单/驱动/二进制输入的前后大小与 SHA256、部署副本身份、逐项状态、HTTP/MCP 请求关联、Job 身份、合成工具 argv/开始证据及退出结论。失败只记录类型、受限错误代码与消息摘要，不把断言原文、令牌、原始请求、工具 stderr 或服务 stderr 写进报告。宿主 stderr 只计字节数，服务自己的受控日志仍在本轮隔离数据目录。

测试助理首次交接只完成七个 TypeScript 文件的静态语法、严格 TypeScript 无输出检查（含未使用变量/参数）与 `--help`，当时未运行宿主；静态检查借用前端现有编译器/Node类型包，不读取前端业务。原 `ordinary-business-freeze.sha256` 保留该交接输入，不能当作修后驱动身份。

主代理随后完成当前生产debug/release构建及AI夹具编译：基础debug13项通过，最终扩展debug/release各21项/53Jobs通过。扩展首轮错误假定保存期间可以同归属修改本地备份而超时，仅修驱动为保存持锁排队及读取备份CAS竞争；第二轮最终报告发布EPERM仍计exit1。共享报告发布针对Windows共享冲突增加最多6次有界退避，第三轮debug正式exit0；最终驱动九文件身份见根artifacts/ordinary-business-driver-final-20261010.sha256。完整终态与原失败目录均在根交接/todo登记。

独立 `settings-commit-uncertainty-smoke.ts` 复用当前冻结辅助，预构建后直接运行；debug/release各18项/12Jobs通过，覆盖远端先写入再断连及HTTP/MCP取消、本地原备份不变、POST一次、锁释放/卸载及双方端口释放。它不证明插件解析完整成功响应后才取消的窗口，不连接真实外部服务。

真实模型、外部配置服务、发布源工具和真机单独验收。原普通扩展仅证明下载/解压失败的旧版本保留与事务清理；目录提交失败恢复由下面的独立专项验证，不能借记原普通矩阵。

## 工具供应真实提交失败专项

Windows/NTFS与PowerShell 7环境下，消费预构建的宿主及tool-supply插件，不调用Cargo或自动构建：

```powershell
node tests/tool-supply-commit-failure-smoke.ts
node tests/tool-supply-commit-failure-smoke.ts --release
```

`--probe-only`仅执行独立NTFS探针，不算插件动态验证；`--bin-dir`、`--powershell`可显式选择入口。下载门闩期间只对本轮事务设置子孙继承的删除拒绝，先验证旧target备份成功、新payload提交失败及backup恢复成功，再运行真实插件。目录监听顺序、新状态/新旧内容字节、锁与PID共同核对提交分支；公开提交错误被清理错误覆盖时，不冒充得到插件原始Win32错误。

预期Job失败且cleanup_failed，旧代进入draining并拒绝重载；不能记插件cleaned。正常关闭旧宿主并撤销ACL后，驱动仅人工回收本轮已核对边界和非链接的事务残留。重启以独立新Job恢复升级及移除，原失败Job保持失败，下载恰为v1、失败v2、新Job恢复v2各一次。访问ACE恢复与DACL自动继承标志差异分别记录，不宣称完整安全描述符字节相同。

原debug9119940d失败因断言错误期待插件内部文案，保留报告不计通过；修后按宿主公共CleanupFailed精确匹配。runtime末帧修补后debug96efe620/release878aff0d两轮各16检查/5Jobs/31输入稳定通过，宿主、夹具及合成源正常收口。报告位于根artifacts的tool-supply-commit-failure独立目录；这仍仅证明Windows/NTFS与合成文本ZIP，不表示真实工具源或其他文件系统通过。
