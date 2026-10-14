# 安卓包插件四 Job 真实服务窄验收

本目录只运行主代理已构建的 Rust 宿主、当前安卓包插件及预编译独立工具。作者本批没有运行 Node、编译、测试或服务；脚本语法与动态验收交主代理串行执行。

## 本次部署与身份

读取 `backend/plugins/android-packages/` 的实际 `package.json`、`manifest.json`、`manifest.example.json` 和 `aliases.example.json`，要求双清单字段一致、协议4、七贡献短名及七 alias 的 identity/full target/wrapped 投影。源文件只读，不修改生产包或冻结原帧测试。

把已构建插件二进制复制到本次便携目录，复制的 portable manifest 仅覆盖 args 为 `--config` 和本次绝对配置路径；源双清单摘要与变更后 portable/最终宿主清单分别记录。用现有 CLI 公开 `materializeManifest` 映射最终入口；空插件宿主先就绪，随后发布自有目录，调用公开 HTTP load。七 alias 配置按冻结示例原字节复制给 `APK_OPERATION_BINDINGS`，input 是字符串 `identity`，外部 target 是完整 ID，实际插件消费短操作。

这段是便携目录映射与公开 load，**不计在线 TGZ 安装、CLI install、正式原包或 npx 分发**。现有 native 打包 helper 会执行 Cargo/npm，因此本脚本不导入它。当前 source package 只声明 Windows x64，脚本要求真实已声明平台，不临时虚构其它平台条目。

报告同时记录原插件、实际复制执行插件、源双清单、包描述、alias 原文、本次配置、最终部署清单、独立工具、宿主的字节数及 SHA256，并核运行前后相同。config 只配置本次假 apkanalyzer 和独占 scratch，不包含签名材料。

## 最小执行交接

主代理先把本目录 std-only `tool.rs` 编译为绝对路径可执行文件。以下仅为待执行交接命令，脚本不调用 rustc：

```powershell
rustc --edition=2024 scripts/android-packages-smoke/tool.rs -o G:/DeviceForgeEvidence/android-manifest-tool.exe
node scripts/android-packages-smoke.mjs --tool G:/DeviceForgeEvidence/android-manifest-tool.exe
node scripts/android-packages-smoke.mjs --release --tool G:/DeviceForgeEvidence/android-manifest-tool.exe
```

宿主与插件分别读取 `backend/target/debug` 或 `release` 已有入口，缺少就失败，不自动构建。执行输入枚举应包含这两二进制、工具及本脚本/只读 helpers；此前43原帧通过不能替代本4 Job 动态证据。

## 四 Job 与工具关联

| Job | 提交入口     | 操作                                | 实际断言                                                      |
| --- | ------------ | ----------------------------------- | ------------------------------------------------------------- |
| M-H | HTTP旧alias  | android.package.manifest            | 旧operation/input同一Job，完整清单DTO/XML/字符串版本号/null   |
| M-M | MCP新target  | plugin.android-packages.manifest    | 同Job宿主result/artifacts包装，业务DTO与旧alias等价           |
| E-H | HTTP新target | plugin.android-packages.extract_apk | 唯一实际host Artifact，GET与下载原APK字节/SHA/logID           |
| E-M | MCP旧alias   | android.package.extract_apk         | 同Job旧source_artifact_id/entry/artifact投影，GET与下载原字节 |

每次提交前后检查新增一 Job；本次总集合恰为四 Job。HTTP/MCP交叉 GET 与事件原文一致，唯一终态为 Succeeded；卸载后历史operation/input/result不变。其它五操作仅检查注册目录与有效预算复制，不宣称业务通过。

两个 manifest 输入是不同固定APK字节，均为独立手工ZIP，不依赖公共核心生成期望。两个工具同时 ready 后先核 Running，再 release。工具每个私有任务目录与工具PID建立一个独占观察目录，保存真实 argv、实际输入字节、私有输入/工作目录、父插件PID及真实执行路径。Windows 用 Toolhelp和父进程查询取得真实身份；随后调用方匹配上传摘要到一个Job，核父插件路径及二进制摘要。没有固定marker冒充并发调用。

成功后分别核工具PID与父插件PID实际不可见、私有目录删除及scratch空。退出意图事件只记录工具自身的意图，不能当OS退出码。两个无工具extract只关联同Job宿主request/log，不直接采其插件OS PID；报告明确未采，不能从服务下载推断该PID观测。

## 日志、失败与边界

宿主正常shutdown200、直接进程exit0、监听端口实际可重新绑定、四Job各唯一插件调用开始/结束日志、所有公开响应ID（含两次二进制下载）退出后落盘，全部完成后才标passed。每个关联日志必须同记录同时含job_id/plugin_request_id/plugin_id与提交log_id，不把响应ID总数扩大为逐Job日志配对数。插件Request ID来自真实宿主日志，本脚本没有截获生产stdin原帧。

正常与失败都保留本次临时根、便携部署、配置、工具观察、数据与日志摘要索引/checkpoint；固定报告在 `artifacts/android-packages-smoke-debug.json` 或 release 对应位置。首业务失败阶段/请求不会被finally的shutdown覆盖；收口错误另外记录，passed保持false。只收口spawn返回的自有宿主，不扫描/强杀未知工具PID，不删除残留目录冒充清理。

本组不证明注册原子性、内部成功资格竞争、确定性CleanupFailed、合作取消、120秒墙钟工具期限、派生树/外部资源完全清理、真实平台工具、七业务等价、npx、浏览器、真机或性能。普通问题按此验收项回流；阻断即时反馈。
