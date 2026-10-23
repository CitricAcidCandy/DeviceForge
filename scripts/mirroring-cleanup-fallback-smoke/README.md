# 投屏设备清理有限重试独立进程验收

本模块由测试助理独占，入口为 `scripts/mirroring-cleanup-fallback-smoke.mjs`。只使用主代理冻结的宿主、新插件和本目录构建的 fake ADB，不调用真实 ADB/HDC，不访问用户 7031/5173，不操作手机或现场服务，不重置任何生产 `cleanup_failed`。本次交付未编译、未启动服务、未执行黑盒；由主代理统一构建运行。

## 文件职责

- `fake-adb.rs`：真实独立工具进程；严格核对当前启动、就绪、版本、PID 身份与远端清理脚本，按计划注入故障。
- `fixtures.mjs`：独占计划、模拟资源状态、实际 DFML 视频包就绪与案例断言。
- `processes.mjs`：逐调用 OS 句柄门闩、直接工具及插件退出证明、探针收尾。
- `evidence.mjs`：有限字段会话摘要、响应日志 ID 落盘、独占端口及共享预算粗粒度核验。
- `host.mjs`：每例独立用户根、业务数据和标准输出错误文件，仅关闭本轮直接创建的宿主，不复用用户配置根。
- 上级 `mirroring-cleanup-fallback-smoke.mjs`：完整 `runCase`、单例/全量命令行、冻结输入、独立宿主生命周期和失败保留。

只读复用 `../mirroring-webrtc-smoke/socket_server.rs`，支持当前 3.3.4；不使用旧 `mirroring-streaming-smoke/fake-adb.rs`。后者目录仅复用 `prepareFixture`、黄金媒体字节、DFML 解包与参数解码等纯辅助函数，生成的媒体与状态全部写入本轮新目录。实际启动参数、ready 和 cleanup 精确比对，不从生产命令反推期望，也不省略版本身份以迁就旧夹具。

## 主代理编译

在 `G:\Rust\DeviceForge` 执行以下命令。测试助理没有执行它们，不占用共享 Cargo 构建队列。

```powershell
rustc --edition=2021 scripts/mirroring-cleanup-fallback-smoke/fake-adb.rs -o artifacts/mirroring-cleanup-fallback-fake-adb.exe
rustc --edition=2021 scripts/harmony-screenshot-smoke/process-probe.rs -o artifacts/mirroring-cleanup-fallback-process-probe.exe
```

探针可复用已经冻结、与当前源文件一致的 `process-probe.exe`，无需重复编译。新插件由生产 worker 与主代理冻结构建，本模块不构建插件、不修改 SDK/宿主。

## 精确命令行入口

`--frozen-input` 指向已有宿主冻结目录，其中必须有 `apk-server.exe`；`--plugin-input` 必须显式指向本次插件冻结目录，包含 `manifest.json` 与 `deviceforge-mirroring-plugin.exe`。示例宿主路径是既有冻结制品，而非用户预览服务；主代理如另有已核定冻结宿主，替换此参数即可。

```powershell
$hostInput = 'G:\Rust\DeviceForge\artifacts\plugin-publication-completion-20261023\frozen-03\backend'
$pluginInput = '<本次新插件冻结目录的绝对路径>'
node scripts/mirroring-cleanup-fallback-smoke.mjs "--frozen-input=$hostInput" "--plugin-input=$pluginInput" --tool=artifacts/mirroring-cleanup-fallback-fake-adb.exe --probe=artifacts/mirroring-cleanup-fallback-process-probe.exe --server-version=3.3.4
```

旧插件行为失败原件单独跑，不把它算入新版通过：

```powershell
$oldPluginInput = '<旧插件冻结目录的绝对路径>'
node scripts/mirroring-cleanup-fallback-smoke.mjs "--frozen-input=$hostInput" "--plugin-input=$oldPluginInput" --tool=artifacts/mirroring-cleanup-fallback-fake-adb.exe --probe=artifacts/mirroring-cleanup-fallback-process-probe.exe --case=list-once --server-version=3.3.4
```

仅打印参数帮助：`node scripts/mirroring-cleanup-fallback-smoke.mjs --help`。所有选项使用 `--名称=值`，拒绝重复与未知参数。默认 `--case=all`；也可逐个选择下面的名称。服务版本默认 3.3.4，可显式指定 3.3.1。

## 验收案例

| 名称 | 故障注入与预期 |
| --- | --- |
| `success` | 无故障；Complete，同代新 MCP 会话可准入并完成清理。 |
| `list-once` | 首次 `forward --list` 退出 1，第二次成功，再删除及查询确认；最终 Complete，新会话可准入。 |
| `remove-reply-lost` | 精确归属删除已生效，但工具退出 1；再次查表确认消失，不盲目重删；最终 Complete，新会话可准入。 |
| `list-always` | 连续查询退出 1，最多两次；保留未确认映射，Failed，后续 HTTP/MCP 准入与卸载仍 409，同 ID 重载 409。 |
| `foreign-forward` | 原本地端口被其他设备和 scid 映射占用；不执行 remove，完整保留外来映射，Failed 并持续保护。 |
| `cleanup-once` | 原严格远端脚本第一次模拟退出 73，未删除资源；第二次成功，不把未知退出码当暂时错误。 |
| `shared-budget` | 首次查询需要 2400 毫秒，必须在原 2 秒预算内被截断，不得启动第二轮；Failed 且保护继续保留。 |

每例独立复制 fake ADB、创建计划和数据根、启动全新独占宿主；上一例 `cleanup_failed` 不跨例污染。使用 legacy `open`，显式 `audio:false`、`control:false`、零重连。必须同时看到完整 DFML 视频包与本次媒体套接字实际发送标记再 cancel，不能以刚出现元数据当作设备已准备好。

主代理首轮发现旧公共宿主辅助器未隔离用户根，宿主在就绪前退出；失败原件保留且不计行为先红。当前改用本模块的独立用户根宿主辅助器，不修改共享辅助器。后续旧版行为对照已实际运行到清理终态，首个转发查询退出1即由旧插件返回Failed；对应新插件预期仍需完整新轮验证。

主代理最终新轮 `artifacts/mirroring-cleanup-fallback-smoke-d36e9334-827d-417e-81ae-b2f0202ad12a/report.json` 已取得7/7通过，输入摘要稳定，7个宿主正常退出；逐进程与端口收尾通过。该结果覆盖假ADB及合成DFML，不覆盖真实手机、WebRTC媒体或原现场失败根因。

暂时失败只使用 ADB 通用退出 1 或远端已批准的 73；未知命令、合同不符与夹具自身故障使用其他错误码，绝不计为暂时成功。所有删除前必须查表，参数仅允许 `-s <本轮声明设备>`；禁止 `kill-server`、`--remove-all`、`pkill`、`killall` 等全局命令。

## 证据、退出与边界

每次生成全新 `artifacts/mirroring-cleanup-fallback-smoke-<UUID>/`。总报告及每例 `report.json` 保存输入 SHA-256、案例、session ID、代次、响应 `log_id`、直接工具 PID/受控 argv/类别/时间、故障注入、模拟资源、OS 原句柄退出证据和独占端口回收状态。旧失败原件不覆盖、不自动删除。

报告不序列化会话 `input`、请求体、输出、SDP、ICE、任意业务错误正文或凭据。argv 只来自本轮合成命令；宿主原始日志仍在独占数据根，不复制任意正文到报告。失败摘要只保留阶段、错误类型、断言操作及白名单标量，避免异常对象间接泄露输入。

正常路径通过公开 shutdown 关闭独占宿主，要求宿主退出 0，插件和每次工具的 OS 句柄都确认退出，所有探针正常退出、宿主及模拟媒体端口释放。失败时保留首个失败，并让本轮 fake ADB 自退、关闭独占宿主、逐个回收自己的探针；不扫描杀历史 PID，不终止用户进程。强制收尾或未确认退出不能算通过，报告列出回收失败。

`shared-budget` 是带进程、门闩和调度开销的粗粒度反续期证据，允许远端工具观察跨度低于 2800 毫秒；这不是把生产 2000 毫秒预算放宽。精确同一绝对 deadline、硬失败分类与完整安全反例由 worker 单元测试负责。合成媒体不证明真机清理、解码播放、WebRTC 错误分段、局域网、性能或正式分发，本轮不执行无关门禁。
