# Harmony 独立协议业务验收

本组通过手写协议4 Request、Ready、Start、Cancel与假HDC真实子进程观察业务，不引用生产解析器、内部函数或期望生成器。连接与断开新增十五项独立协议测试，已由主代理验证完整协议72项通过；原完整详情、应用启停、重置、自动 ability、安装和清理回归继续保留。截图新增36个测试函数，已经注册原帧入口与独立夹具；主代理首轮29通过、7失败，失败修复后尚待复验，不把既有72项证据转计本批。

## 主代理执行

在backend目录、生产插件冻结并纳入workspace后执行：

```powershell
cargo test -p deviceforge-harmony-device-plugin --test protocol
```

截图定点入口为 `cargo test -p deviceforge-harmony-device-plugin --test protocol screenshot::`。后续完整协议应在Windows包含原72项与新增36项，共108项；实际数量和结果以主代理执行输出为准。

测试首次运行会以rustc编译本目录std-only假HDC，保留每场景Temp目录、请求与响应原帧、真实插件退出码、stderr、工具argv、PID和安装字节。每个场景独占工具、配置、scratch和原件，成功或失败均保留。失败兜底杀进程有明确标记，不计成功清理证据。

## 当前覆盖

- 发现固定list targets、空结果与精确[Empty]哨兵、八项online可用性，原标识顺序，重复/非法/诊断/控制字符/128条和200字节边界整份失败。
- 应用列表固定argv与完整去首尾空白文本，卸载保留合法failed包名并使用固定参数，工具环境不继承本次注入的宿主入口和令牌变量。
- 严格十一短贡献、设备封套、UUID/点分ASCII包名、配置未知及重复字段、缺依赖、非法HDC入口、显式缺配置和配置限额。
- HAP唯一授权pointer与ID、显示名、64MiB与大小/摘要资格，绝对普通源及字面父段拒绝；私有input.hap核实际原字节、源后改不影响副本、输出私有路径遮蔽及完成后实际删除。
- HDC零退出与大小写无关的独立成功行后缀，两流失败优先、非UTF8、非零退出和单流限额；取消/EOF、零预算、延迟Start及原截止点清理。
- Windows真实打开文件禁止删除时cleanup=failed、结果不发布、私有目录保留，句柄释放后无后台删除。
- 应用启动、停止和重置的完整固定 argv 与独立成功行；可省略 ability 时先查询详情，再沿原调用期限按首模块 mainAbility 启动，不猜后续入口；详情失败、取消或到期不启动下一命令，显式空/null/非法能力在配置之前拒绝。
- 独立详情固定一次 `bm dump -n`，直接保留完整未知对象、无模块及不可启动模块，根包名匹配，合法 JSON 诊断词不误拒；错误标题、重复键、尾随、根数组、两流UTF-8、stderr精确[Fail]、非零退出、两流限额、取消/EOF/到期及零预算不发布部分结果。
- 连接与断开固定单次 `tconn address` / `tconn address -remove`，规范IPv4和小写localhost、1/65535端口及五位数字端口保留字面值；不带 `-t`，不发现、不管理daemon、不重试或回滚，不创建安装scratch或输出产物。新连接和重复连接两条大小写精确的独立成功行保留完整文本；断开仅接受零退出及两流空白。未知目标、双流失败优先、未知响应、UTF-8、非零退出和各流1MiB限额均要求固定错误。
- 提供者封套必须显式null与input/address，缺失、所有非null设备值、未知字段和额外命令参数在配置之前拒绝；输入产物也先于配置或副本拒绝。预取消、零预算、延迟Start后原期限已过均零工具；运行取消/EOF/到期确认本次客户端退出且无补偿命令，延迟Start后释放门闩也不能重启原预算。

## 证据边界

本组不能证明HTTP/MCP、宿主共享设备锁、热装卸/旧代隔离、正式包/npx、共享HDC daemon、派生进程树、设备事务回滚、性能或真机。Future丢弃、worker panic和清理点竞争由生产内部确定性测试另验，不能从本组公开进程观察扩大结论。Android先前通过轮次属于其它插件，不计Harmony验证。

## 截图夹具准备与独占边界

实施模式为 `plan-and-build`，仅修改本插件测试层。合同为[截图实施裁定](../../../docs/Harmony截图插件实施裁定.md)，当前冻结 SHA256 为 `B4590901C0128E0813C65FC9A9D39F92CC4B4C15C9F98CCA1A5013792C65CE83`。共享 JPEG 与宿主接缝由主代理先验证；截图生产实现由后端开发负责，协议测试不导入生产模板、Base64、JPEG 或回执解析器。

| 单元 | 责任 | 输入、输出及副作用 | 不承担 |
| --- | --- | --- | --- |
| `fixtures/screenshot.rs` | 识别五条固定 HDC 命令的阶段与本次标识，应用手写调用计划、远端文件副作用及有界 Base64 编码 | 读取场景私有计划和图片，写真实 stdout/stderr、原件与模拟远端目录 | 生成生产期望、发布宿主产物、代替 JPEG 视觉验收 |
| 夹具内部 `late` 单元 | 真实派生晚到目录、writer 或 reader，固定六秒退出点与显式触发 | 独占子进程、PID/ready/退出意图原件，writer 实际建文件，reader 实际持文件句柄 | 管理真机子进程、把自行退出算成插件成功清理 |
| `cases/screenshot.rs` 与狭窄支持接线 | 手写协议原帧、完整 argv 期望及真实进程/文件断言 | 后续独占场景、授权输出、原帧和直接进程句柄 | 宿主别名投影、Job 历史、卸载 `draining` 或内部 Future hook |

新增夹具模块已接入 `fixtures/hdc.rs`，`cases/screenshot.rs` 已注册到 `protocol.rs`；修复后截图36项已全通过。保持原假 HDC 的 argv/PID/门闩机制，在分配普通调用目录前识别 `worker_entry()` 并立即按返回值退出，在 ready 前调用 `before_ready()`，门闩释放后由 `write_response()` 返回截图计划的真实退出意图。没有 `screenshot-fixture` 标记的场景继续走原夹具。五条完整 argv 均由测试按照冻结裁定手写，夹具识别阶段或标识不代替完整脚本断言。生产脚本冻结 SHA256 为 `32214A405CE36FB10C0428B6113CDEC76B7A95FB7811ADF56DD7A04C56C0DEEB`。

### 场景计划

场景根创建 `screenshot-fixture`，正常图片原字节置于 `screenshot-source.jpeg`。每个 `plan-NN` 保留原 `stdout`、`stderr`、`code` 与释放门闩；回执由测试手写，仅替换 `{{TOKEN}}`、`{{REMOTE}}`、`{{SIZE}}`，非法 UTF-8 原字节仍直接输出，不经过 UTF-8 修复或生产解析器。

- `screenshot-action` 为 `none`、`capture`、`directory`、`directory-without-owner`、`clear` 或 `clear-with-leftover`。副作用只落在本场景 `screenshot-remote/deviceforge-screenshot-<token>`；删除仅处理两个已知文件及空目录，不递归清扫。副作用失败留存 `remote-action.outcome`，回执计划仍须准确描述该失败。
- read 计划设置 `screenshot-base64` 时，夹具从当前远端图片逐块编码，保留 `base64-counts.json`，再输出手写帧尾；设置 `screenshot-body.bin` 时改为直接发送损坏或超限正文。二者互斥。成功写完两流的工具另保留 `stream-counts.json`，分别记录真实正文、帧尾、完整 stdout 和 stderr 字节数，不把正文长度冒充完整帧长度。
- `screenshot-worker` 为 `writer`、`directory` 或 `reader`，只用于对应 capture/read 阶段。worker清空业务环境；Unix使用三路 `Stdio::null`，Windows以 `CreateProcessW/STARTUPINFOEXW/HANDLE_LIST` 将可继承句柄限定为自己创建的NUL，并由该句柄提供三路标准I/O。Windows派发前仍清除假HDC三个标准句柄的 `HANDLE_FLAG_INHERIT`，不关闭客户端句柄。`hdc-stdio-before.json`、`hdc-stdio-after.json`、`late-worker-stdio.json` 与 `late-worker-inheritance.json` 保存真实句柄、继承标志、类型、PID和唯一allowlist；API失败保存具体操作和错误码。仅清除三个标准句柄不足以隔离祖先遗留管道；复验原件证实插件早已真实退出，测试管道收集仍等待worker。限定allowlist后，保持原插件五秒退出与worker六秒看门狗，退出后存活及后触发断言已通过。父客户端退出不触发worker完成；reader在ready前实际打开图片，writer在触发后实际建立目录及写图片。
- worker 自身第一次进入后固定六秒退出点；没有触发也由自有看门狗退出并留下 `late-worker.watchdog-expired` 与退出意图124。测试在确认本次插件或客户端已退出后，以原子写入 `late-worker.trigger=1` 释放迟到副作用，并持本次 PID 句柄确认实际退出。Windows通过同一进程句柄查询并保存实际退出码，正常触发要求0、自有看门狗要求124；Unix仅观察退出，不声称采集了非直接子进程的操作系统退出码。退出意图文件不是操作系统退出码或进程退出证明。
- `screenshot.stage`、`screenshot.token`、`late-worker.pid/ready/mode/started-ns/elapsed-ns/exit-intent`、`late-writer.created` 与 `late-reader.bytes` 分别保留阶段、所有权、真实子进程和副作用原件。任何看门狗、失败兜底或未确认均不计成功清理。

### 已验证的截图原帧覆盖矩阵

首轮36项29通过、7失败原件继续保留为 `artifacts/harmony-screenshot-targeted-protocol-20261012.txt`；三标准句柄窄修后的两项失败另保留 `artifacts/harmony-screenshot-reviewed-late-reader-writer-20261012.txt`。本轮限定晚worker继承allowlist后的定点结果为unknown三项、watchdog一项分别通过；全截图批次为36/36、exit0，实际56.86秒，原件 `artifacts/harmony-screenshot-handle-list-all-20261012.txt`。这不是整个108项协议或工作区门禁的通过证据。具体错误文案按公开运行库与冻结合同手写，不放宽取消或清理预算：缺终端及未知远端要求 `cleanup:failed`；取消、EOF与原截止点胜出时保留精确控制错误及原 `failed`，其它未知业务路径要求 `插件资源清理未确认`。完整回执后的业务失败仅在真实固定清理成功时要求 `cleanup:complete`。`input:null`对象资格错误与同批 `Start→Cancel` 已按真实协议纠正，不把测试调用包装器丢弃计为内部Future验证。

| 分组 | 关键断言 | HDC 调用预期 |
| --- | --- | --- |
| 零工具准入 | 严格 `device_id/input:{}`、未知字段、输入产物、缺输出授权、授权根资格、预取消、零预算及延迟 Start 原期限耗尽 | 0 |
| 正常 | `probe→capture→size→read→clear` 完整固定 argv、同一32位标识、合法 JPEG 原字节、`result:null`、唯一 `screenshot.jpeg` 输出，私有及远端实际删除 | 5 |
| 平台资格 | 探测编码不匹配、错标识、重复/缺回执、非零状态、UTF-8、两流失败优先及1MiB边界 | 1；缺终端回执保留未确认 |
| 目录/截图 | 不覆盖碰撞目录；owner失败；精确官方成功诊断；CAPTURED错标识/缺失/重复/非零，晚到目录与真实writer | 目录拒绝2；已确认非零后清理3；未知writer保持2 |
| 大小 | 正负号、溢出、零值、64MiB精确/超一字节、两侧ASCII空白、错标识/缺回执、所有权拒绝 | 已确认失败后清理4；未知大小进程保持3 |
| 接收/解码 | 规范Base64、padding及尾部位、截断、内嵌空白/诊断、额外回执、编码硬限、大小不一致、损坏或不支持JPEG、真实reader未退出 | 完整READ_DONE后清理5；未知reader保持4 |
| 清理/输出 | 缺/错/重复CLEARED、删除失败、未知文件、既存输出不删、授权输出不覆盖、已写未交付不声明 | 正常链5；未确认不得发布 |
| 每阶段取消/期限 | probe/capture/size/read/clear 门闩内分别Cancel及EOF，原截止点不能逐命令重启；已确认writer且read未派发时可在同一清理点删除，未知子进程必须Failed | 按最后已派发阶段核实，禁止补发截图/reader或续两秒 |
| 晚到与终态 | 插件退出后触发晚到writer/reader，核实际PID、文件/句柄与固定自退出；晚到成功不能改变已返回的取消/未确认 | 不借worker自退出宣称生产确认 |
| 宿主层后续 | 十一贡献/十能力、八设备availability、别名保留artifacts、HTTP/MCP JPEG元数据和原字节、取消历史与CleanupOutcome及卸载draining分层 | 根服务驱动另行授权及验收 |

内部 Future 丢弃、文件 worker 创建到登记的竞态及真实关闭顺序属于生产内部确定性验证；原帧层明确检验 EOF/合作取消，不把丢弃测试调用包装器写成内部 Future 已验。结构 JPEG 夹具也不提供像素可解码或视觉正确证据。
