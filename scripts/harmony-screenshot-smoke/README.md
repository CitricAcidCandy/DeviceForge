# Harmony 截图独立验收

此目录当前按十二贡献、十一声明能力、两设备各九项 availability 验收截图；历史冻结快照仍保留十一贡献、十定义能力的旧结果。发现阶段会额外执行四次输入资格探测，但业务场景仍只提交截图操作。服务入口消费主代理交付的七成员快照、独立假 HDC 和真实 Windows 进程探针；不运行 Cargo、rustc、打包器，不连接已有服务。

## 服务输入和执行

快照保留同次构建的 `backend/target/<debug或release>/apk-server.exe`、`deviceforge-harmony-device-plugin.exe`、`validate-plugin.exe`，以及 `backend/plugins/harmony-device/` 下的 manifest.json、manifest.example.json、aliases.example.json、README.md。源文件和副本逐成员核大小及 SHA256，再写快照 identity.json。入口还冻结自身全部相对导入依赖、夹具原程序及夹具 Rust 源码；结尾再次核对，冻结输入变化使验收失败。

假 HDC 必须来自包含截图模块的 `backend/plugins/harmony-device/tests/fixtures/hdc.rs`，进程探针来自本目录 `process-probe.rs`。探针只取得本次目标和直接父进程的真实等待句柄，记录创建时间、路径、就绪状态、真实 OS 退出码；单次观测门闩用于插件退出后再次确认晚 worker 仍运行。探针固定六十秒看门狗，不结束目标进程，不能代验整棵派生树。

```powershell
$screenshotSnapshot = (Resolve-Path 'artifacts/harmony-screenshot-frozen-debug-20261012-141929').Path
$screenshotTool = (Resolve-Path 'artifacts/harmony-screenshot-fixtures-20261012/fake-hdc.exe').Path
$screenshotProbe = (Resolve-Path 'artifacts/harmony-screenshot-fixtures-20261012/process-probe-observable.exe').Path
node scripts/harmony-screenshot-smoke.mjs --snapshot-root $screenshotSnapshot --tool-binary $screenshotTool --probe-binary $screenshotProbe --case normal
node scripts/harmony-screenshot-smoke.mjs --snapshot-root $screenshotSnapshot --tool-binary $screenshotTool --probe-binary $screenshotProbe --case all
```

三个输入参数均为现有绝对路径。`--case` 可选 normal、cancel、deadline、late、leftover、queued、all，默认 all。release 追加 `--release`，且快照必须含对应 release 三个程序，不能借记 debug 的结果。每轮独占工具根、旁置配置、数据目录和端口；业务失败或清理未确认后不复用受污染宿主。默认不设置令牌，避免继承当前进程的业务环境。

all 共十六独立轮：普通一轮、五阶段取消、五阶段真实三十秒期限、三类晚资源、未知文件、未知资源持锁排队卸载。期限轮累计至少一百五十秒，正常等待不能缩短为模拟期限。报告写入独立 `artifacts/harmony-screenshot-service-<profile>-<uuid>/report.json`；实际日志、SQLite、配置、二进制副本、工具 argv、门闩和探针原件留在本轮 Temp 目录，报告附有界索引与摘要。

## 契约与证据

`screenshot@1` 为 device/write/30000ms，业务输入严格限定空对象，不接收用户路径或输入产物。贡献接收 `{device_id,input:{}}`；既有格式2别名保持 `kind:value`、`wrapped:false`，最终完整返回 `{result:null,artifacts:[metadata]}`，不得投影成裸空值。插件全局 outputs=true，发现和 packages 仍返回空产物数组。

正常截图分别覆盖 HTTP/MCP 的 capability、短贡献、格式2别名共六入口。每入口唯一插件 Job、五条手写完整固定 argv，与生产脚本独立对照；每个 HDC 就绪时取得本次 HDC 和直接父插件等待句柄，核受限环境标记全零、任务后真实 OS 退出、私有与模拟远端目录清理。错误输入覆盖三入口两传输，独占拒绝工具目录确认零新增 Job 和零工具。

产物元数据字段严格限定 `created_at,filename,id,media_type,sha256,size`，created_at 为正安全整数。HTTP 实际下载并核 image/jpeg、大小、nosniff、完整原字节和 SHA256。MCP `artifact.inspect` 创建独立元数据 Job，核同一元数据、共享任务历史和事件；目前公开 MCP 没有原字节下载接口，不能将 HTTP 字节证据写成 MCP 字节证据。元数据 Job 与 Harmony 插件 Job 分别计数和关联日志。

同设备写锁用首 HDC 真实就绪后提交第二任务、第二任务零工具证明；不同设备在首任务仍持门闩时实际完成第二截图。第二任务提交前完整配置原子替换，且首 HDC 就绪证明首插件已读取旧配置。干净卸载和重载核新 generation、旧代拒绝、新代截图及全部既有历史保留。

五阶段显式取消的公开 cancel 接口先提交 cancelled 终态，所以 Job error/result 均为空；插件 cleanup_failed、资源 unresolved 和粘性 draining 分开核对。真实 deadline 和直接卸载触发清理未确认时，在途 Job 为 failed，错误为“插件资源清理未确认，请检查外部资源后再恢复”。未启动的排队 Job 在卸载后 cancelled，零插件调用日志及零工具，不能把三种触发的 Job 状态强行合并。

晚 directory、writer、reader 在 HDC 和插件真实退出后，通过探针门闩再次查询 worker 的实际等待句柄：worker 必须 running/wait_status=258，直接父已退出；随后真实触发晚副作用并取得 worker exit0。卸载409 cleanup_failed、draining、同 ID 重载409 conflict、新提交404、既有历史不变逐项核。未知文件实际使 rmdir 失败，不发布产物；未知资源持锁排队场景核卸载后排队任务不得启动。

每个响应日志 ID 正常退出后落盘；每个已调用插件 Job 唯一 plugin_request_id，开始/结束和提交 log_id 一一对应。明确未调用插件的排队 Job 须没有调用开始/结束日志。退出记录、日志、工具数与 Job 终态互相核对，不以包装退出或目录数量代替实际 OS 退出证据。

## 正式包和 npx

`scripts/harmony-screenshot-npx-smoke.mjs` 消费主代理交付的正式 CLI 原 TGZ、正式 Harmony 原 TGZ、实际打包使用的 release 插件原程序、同一假 HDC、同一进程探针及冻结源码目录。它不打包、不编译、不修改现有 cli-smoke；不得调用旧 Harmony 分发驱动的十贡献、九能力断言来验新版截图。

```powershell
node scripts/harmony-screenshot-npx-smoke.mjs --archive C:\冻结原件\deviceforge-cli-0.1.0.tgz --plugin-archive C:\冻结原件\deviceforge-plugin-harmony-device-win32-x64-0.1.0.tgz --plugin-binary C:\冻结原件\deviceforge-harmony-device-plugin.exe --tool-binary C:\冻结原件\fake-hdc.exe --probe-binary C:\冻结原件\process-probe-observable.exe --source-directory C:\冻结原件\harmony-device
```

六个参数均必须提供现有绝对路径。源码目录额外包含 harmony-device.config.example.json。主代理串行准备正式包，原生打包使用显式目标时必须传入实际打包所用的目标目录原程序，不能改用另一构建的 release 程序。当前冻结截图原包包含十二贡献和十一能力；旧十一贡献快照仅作为历史原件，不能借给当前源码验收。

真实 `npx --package <CLI原TGZ> deviceforge plugin install <Harmony原TGZ>` 安装后，核正式六成员原字节与安装目录、当前平台 native 程序、便携清单及公开 materializeManifest 生成清单；别名和 HDC 配置模板须与冻结源码原字节一致。管理员从模板生成本轮 bindings 与程序旁置配置，不改变包成员或生成清单。

两阶段共享同一 CLI 原 TGZ、Harmony 原 TGZ、实际 npx 缓存、安装目录、数据和端口。第一阶段显式可选令牌，缺令牌 HTTP/MCP 均401；第二阶段删除 APK_API_TOKEN，以默认免鉴权启动。随机令牌不进入命令参数、报告或保留日志。不传 `--ip`，启动须报告默认0.0.0.0；HTTP 与 MCP 用不同临时端口，两阶段各核正常关闭、包装 exit0 和双端口释放。

每阶段发现一次，再验截图六入口；每阶段七个插件 Job、六个元数据 Job、三十一次 HDC。两阶段合计十四唯一插件 Job、十二元数据 Job、六十二工具；第二代须不同、第一阶段历史和事件保留。全部原包成员、真实 npx 缓存、served plugin-host.js、两阶段资源身份和冻结输入再次核对，插件 Job/请求/日志逐项关联。报告与真正执行的两份原 TGZ 写入独立 `artifacts/npx-raw-*/`，Temp 原件附有界索引。

## 2026-10-12 实际结果

冻结 debug 快照为 `artifacts/harmony-screenshot-frozen-debug-20261012-141929/identity.json`。服务首批十五轮全部 exit0；补强后的普通轮与新增排队卸载轮分别定点通过。以下是实际报告，不能合成一次尚未执行的 all 命令：

| 场景 | 实际结果 | 插件Job / 元数据Job / 工具 | report.json 所在目录 |
| --- | --- | --- | --- |
| 首批 normal | 1/1 | 15 / 7 / 63 | harmony-screenshot-service-debug-369dd738-fae0-4f90-a750-174eea48ed02 |
| cancel | 5/5 | 10 / 0 / 20 | harmony-screenshot-service-debug-b70f7059-b616-4db7-a7d9-4413b035a404 |
| deadline | 5/5，真实30秒 | 10 / 0 / 20 | harmony-screenshot-service-debug-968e0a6c-c26b-48c7-aa46-3d2d6b0126a2 |
| late | 3/3 | 6 / 0 / 11 | harmony-screenshot-service-debug-5ec06a43-e60b-4da4-b78b-24bf1049cdd2 |
| leftover | 1/1 | 2 / 0 / 6 | harmony-screenshot-service-debug-93cf4653-eb1e-4101-8ad7-f1c097f2082a |
| 补强 normal，输入拒绝零工具 | 1/1 | 15 / 7 / 63 | harmony-screenshot-service-debug-7a536414-204f-4d09-acac-134d28e4c616 |
| 新增 queued-unload | 1/1 | 3 / 0 / 3 | harmony-screenshot-service-debug-ec30de15-d8ce-4006-8a85-3244547b8ff6 |

首批合计四十三插件 Job、七元数据 Job、一百二十工具。按补强 normal 替换首批 normal、再加 queued 场景计，已覆盖十六场景轮、四十六插件 Job、七元数据 Job、一百二十三工具；这是多次独立冻结报告的场景汇总，不是最后源码的一次 all 单轮门禁。排队卸载初次驱动错误地要求在途 Job cancelled，实际日志证明 cleanup_failed 归 failed；已修正驱动语义并重跑通过，失败原件保留于 `harmony-screenshot-service-debug-60bf3bb2-06c0-461d-921e-80d5aa7e2470`，不作为生产缺陷或通过证据。

截图协议过滤测试另有36/36通过原件 `artifacts/harmony-screenshot-handle-list-all-20261012.txt`，其中晚 worker 使用 Windows CreateProcessW 句柄白名单，避免祖先隐藏管道继承使收集器等待。该结果不能扩大为整个 Harmony 协议或工作区门禁。

## 当前源码定向复验（2026-10-13，UTC）

当前 debug 插件与宿主使用重新编译的 `backend/plugins/harmony-device/tests/fixtures/hdc.rs` 假 HDC（旧截图夹具二进制不含输入资格回执，继续保留其失败原件）。截图 `normal` 轮通过 15 个插件 Job、7 个元数据 Job、63 次工具调用，报告为 `artifacts/harmony-screenshot-service-debug-20a0145e-8e9d-4f5f-8b85-e7a76bf6eb02/report.json`。输入 `known` 轮通过 2 个插件 Job、8 次工具调用，报告为 `artifacts/harmony-input-service-debug-c1f8850e-4ecf-47b3-832f-4d8388cc82da/report.json`。

当前截图合同和夹具已验证 `input` 贡献存在，但本轮不执行输入业务；release、正式 TGZ/npx、真实 HDC 与真机仍须单独验收。

当前 observable 探针源码 SHA256 为 `0684A7E1B71E88B55DDB75770E3BF2DF17D98FDB940FBB69EAA7A8FBC8EB0EBF`，实际程序 SHA256 为 `3AEE1EA30B06DEA92E8D84C5097F6A56A1D043902C886CC211B78A637991B10B`。每份服务报告还保留实际输入前后身份。分发入口只完成语法检查，release、正式 TGZ、真实 CLI install 和 npx 尚未运行。

## 未验边界

假 HDC、模拟远端目录、三十一字节结构 JPEG 不证明真机、真实 HDC、共享 daemon、像素可解码、视觉正确或设备状态回滚。公开有限采样不证明内部原子性、未来设备竞争、常驻会话或生产性能。工具和直接父插件真实 OS 退出证据不等于整个进程树清理；npx 包装退出也不等于 Rust 宿主直接 OS 退出。HTTP 字节下载、MCP 元数据、协议测试、debug 服务、release 服务和正式分发必须分别报告完成度。
