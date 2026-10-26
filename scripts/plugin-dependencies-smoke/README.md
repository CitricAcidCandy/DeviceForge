# 插件依赖真实宿主验收

本目录为测试助理的独占夹具。只消费主代理提供的新冻结 `apk-server.exe`，不运行 Cargo、npm、生成器，不接触用户的 7031/5173 服务或设备。未实现的接口、MCP 工具和失败 Job 均真实失败；没有注入执行器、内存成功状态或兼容旧宿主的降级入口。

## 准备与执行

在 `G:\Rust\DeviceForge` 执行：

```powershell
# 仅自检本夹具，不启动产品宿主；本地 HTTP 源测试会自行关闭。
node scripts/plugin-dependencies-smoke/self-test.mjs

# 仅准备 TGZ、v2 完整发布 ZIP、实际模拟工具和计划，不启动任何监听。
node scripts/plugin-dependencies-smoke.mjs --prepare-only

# 主代理提供新冻结二进制之后才执行；不要指向共享 target 目录。
node scripts/plugin-dependencies-smoke.mjs --binary-directory 'G:\Rust\DeviceForge\artifacts\待提供的新冻结目录'

# 也可直接指定主代理授权的新冻结 exe，不要求原文件名为 apk-server.exe。
node scripts/plugin-dependencies-smoke.mjs --binary-path 'G:\主代理提供的新冻结宿主.exe'

# 可显式选择尚不存在的独占证据根；已存在目录会直接拒绝，绝不覆盖失败原件。
node scripts/plugin-dependencies-smoke.mjs --binary-directory 'G:\冻结目录' --output-directory 'G:\本次独占新目录'
```

`--binary-path` 与 `--binary-directory` 二选一；准备模式不接受会被忽略的宿主路径。`--prepare-only` 的来源 URL 固定为不使用的 `http://127.0.0.1:1`。准备期间检查全部 7 个独立组件与 10 个完整发布的归档闭包、声明模式、组件摘要/大小和 Node 原字节，保存 `fixture-check.json`；它仍只证明夹具可准备，报告为 `state:prepared, passed:false`。实际执行另开新证据根，重新生成指向本次随机端口的描述，不直接消费准备轮归档。

`self-test.mjs` 包含客户端单元自检，临时返回受控响应来验证日志、分页、取消和规范化等断言。这些测试与真实宿主执行入口分开，不能计为产品 HTTP/MCP 通过；测试响应与本地监听均在自检结束前回收。

## 契约与范围

- HTTP 路径为 `/api/v2/plugin-dependencies/{target_kind}/{id}`，扫描与安装分别追加 `/scan`、`/install`，提交 `expected_revision` 与可选 `dependency_ids`，修改必须返回真实 Job。
- MCP 查询工具为 `deviceforge.get_plugin_dependencies`，修改操作为 `dependency.scan`、`dependency.install`，均使用 `target:{kind,id}` 和对应修改字段。按当前宿主的 `2025-11-25` 协议执行初始化，携带协议/方法/工具名请求头及无状态客户端 `_meta`，再读取真实 `tools/list`；缺工具、循环游标及日志身份不一致均直接阻断。
- 独立组件在包根附 `dependencies.json`，完整发布 `format_version:2` 的 `dependencies` 是 `DependencyManifest` 对象。来源为本机 HTTP `market`，不是伪装成官方 HTTPS。
- 视图逐字段检查目标、修订、条目状态、来源、版本、可安装与摘要，并独立计算必需依赖是否全部就绪；HTTP/MCP 必须返回同一视图与同一终态 Job。
- 第三方插件标识含本次随机片段，无宿主白名单。真实模拟程序是当前 Node 的独占副本，实际执行 `--version`；下载 ZIP 包含 Node 原字节，宿主必须自行下载、核摘要、解包、绑定并实际执行。
- A 的一次完整插件安装必须自动发现环境与用户目录、只下载缺失必需项，自动绑定并启用；不先调用独立扫描或依赖安装。可选工具声明有真实可用来源，但不得自动下载。B 的一次完整插件安装必须自动复用同一共享绝对路径且直接就绪，整个安装下载源请求增量严格为零，HEAD 也不允许。
- A/B 的服务器组件均已从旧 `runtime:'node'` 改为 `runtime:'script', path:'index.mjs', dependency:{id:<共享运行时>,entry:'main'}`，不是 native。各组件自己的 `dependencies.json` 同时声明必需运行时、探测和来源；分发包不携带 `.deviceforge-runtime.json` 或 `manifest.json`，两者只能由宿主生成。
- 实际插件本体回报 `process.execPath`、PID、父 PID 与 argv；必须与配置快照中的所选运行时及其真实文件摘要一致，并与启动验收驱动的全局 Node 路径不同。父 PID 必须是本轮宿主，带空格与 shell 字符的参数必须原样保留，不能只让 helper 子进程使用正确工具就声称脚本运行时正确。读取并核对宿主生成 marker 的版本和依赖引用；持久化清单中的占位入口与运行时解析后的实际 executable 分开记录，不假定宿主会回写磁盘清单。
- 主要矩阵后正常停止首宿主，再把同一冻结 exe 复制到 `runtime-no-bootstrap/`，使用全新的业务根和用户根，移除 `DEVICEFORGE_NODE` 与全局 PATH，仅提供本轮新建的空 PATH 目录。此宿主单独安装 coldA/coldB：A 下载自建 Node ZIP、自动启用并实际执行，B 零网络复用并实际执行。主要矩阵保留全局 Node 仅为兼容其他旧 `runtime:'node'` 夹具；它不被用作无 bootstrap 验收证据。
- coldB 额外只在完整发布的 `dependencies` 声明运行时，其组件 sidecar 为显式空清单；仍使用 `script+dependency` 入口并验证宿主生成 `.deviceforge-runtime.json`、真实 executable 和零网络复用，不误将组件 sidecar 重复声明当作强制前提。
- 同名独立 `release/server/browser` 分别声明不同依赖，按目标类型隔离；A 同时含服务器和浏览器组件，两者查询及别名扫描均应规范化为所属发布，客户端随后以返回的发布目标继续操作。完整发布通过公开离线导入注册，不写宿主数据库。
- 组件默认空配置在上传后就应自动发现环境变量与用户 `.deviceforge` 预置目录，再验证独立扫描不下载。实际执行快照的绑定必须可用；不强迫宿主将自动路径覆盖到用户原始配置。预置目录是明确的 `user_directory` 发现规则，不伪造共享仓库元数据。
- 两份含可选坏依赖的 v2 发布自动安装时复用必需工具、跳过可选来源；独立依赖 `install` 再分别真实触发摘要错误与缺入口，要求失败 Job、失败摘要、旧配置与旧工具摘要不变，随后实际运行当前与先前成功插件。坏摘要为非零合法格式，缺入口与网络失败归档各有独立内容摘要，避免被已成功工具的内容缓存掩盖。可选失败不得覆盖必需成功或错误地撤销就绪。
- v2 无可下载来源或真实 HTTP 503 时保留 `dependencies_required` 安装记录；恢复本地候选或来源后独立 `install` 完成补救、自动绑定并按启用意图恢复。即使来源恢复可用，独立 `scan` 也不得下载。
- 版本冲突不得误用不兼容程序；独立 server/browser 无声明或空声明、v1 无声明及 v2 空声明完整发布都必须就绪，扫描/安装无网络。过期修订与未知依赖经过公开异步操作产生失败 Job，但不得修改视图或联网；形状错误直接 HTTP 400 且无新 Job。

## 证据与回收

默认报告根为 `artifacts/plugin-dependencies-smoke-<run_id>/`。保存每次 HTTP/MCP 请求及原响应、上传字节摘要/大小、日志 ID、Job 与唯一终态事件、所有下载源请求方法/路径/字节/完成情况、插件归档、前后输入摘要和实际宿主日志。所有配置仅为夹具自建值，不读取真实用户配置或输出环境凭据。

夹具独占源码、准备完成后的归档及实际冻结宿主副本必须始末稳定。被引用的共享打包帮助源码可由其他代理并行修改，变化逐项记录为 `shared_source_changes`，不把无关源码变化误计为宿主运行失败；`inputs_stable` 与 `smoke_inputs_stable` 分别报告全部输入和独占夹具状态。这个边界不放宽实际下载字节、归档或运行 exe 的身份要求。

宿主复制到新证据根后才启动；用户根为本轮 `user/.deviceforge`，业务根和插件目录另行隔离。下载源在同一 Node 驱动中监听随机回环端口。宿主通过公开 shutdown 正常退出，必须观测 OS 退出码 0、原始进程 close、监听可重新绑定，以及归属证据根的进程为空；强制结束即使成功回收也不能计为验收通过。

Windows 进程快照核对 PID、父 PID、创建时间、可执行路径、命令行与祖先链。根路径匹配只是候选，还须属于本驱动或已记录的宿主存活窗口；不因用户编辑器打开证据文件就将其回收。强制回收前再次核身份，只结束精确 PID，不扩大为不核身份的整树结束。就绪后与 shutdown 前都核对监听 PID，拒绝向其他进程持有的端口发关机请求。快照查询使用同步等待的短命 PowerShell，不另启长驻 MCP。

SIGINT/SIGTERM 合作中止会取消业务等待并进入同一回收路径，shutdown 不继承已取消的业务信号。进程、输入和夹具审计分别执行，单项失败不跳过其余检查。异常保留全部失败原件，不删除目录。驱动等待、请求、Job 和回收均有上限；Windows 外部强杀 Node 本身不属于可保证的合作回收范围。

## 独立待测

- [ ] 主代理交付新冻结二进制后运行整个真实 HTTP/MCP 矩阵。
- [ ] npx 两个独立 npm 缓存安装后，换业务根、同一 `.deviceforge`，扫描/安装仍复用且零网络；需新分发包，当前不运行 npm/npx。
- [ ] 真实资源市场、可信官方 HTTPS、代理环境、真实第三方大体积工具。
- [ ] 浏览器执行与产品界面、真机、其他操作系统、长时与性能。

本目录记录用于交接；根 `todo.md` 由主代理合并，不由测试助理越界写入。没有新增 Rust 集成测试，避免绑定仍在添加的公共 router 构造器。

## 独立双缓存 npx 验收补充（2026-10-26）

新增入口 `scripts/plugin-dependencies-npx-smoke.mjs` 与专属帮助文件 `npx.mjs`。不修改既有真实宿主 smoke，也不复用旧 `plugin-installations-smoke/npx-package.mjs` 的硬编码 release 打包逻辑。此入口会运行 npm/npx，但仅在主代理提供冻结目录、调用者明确指定真实 `--profile debug|release` 后执行；没有冻结输入时，只做下列 Node 自检：

```powershell
node --check scripts/plugin-dependencies-npx-smoke.mjs
node --check scripts/plugin-dependencies-smoke/npx.mjs
node scripts/plugin-dependencies-npx-smoke.mjs --self-test
node scripts/plugin-dependencies-npx-smoke.mjs --help
```

自检只覆盖参数拒绝、显式构建档位、主包成员白名单和路径边界，不打包、不启动宿主或监听，不代表双缓存、HTTP/MCP/CLI 集成通过。

主代理给出目录后，使用其中的 `apk-server.exe`、`validate-plugin.exe`。以下以实际 debug 输入为例，目录占位符必须替换，不得把 debug 二进制标成 release：

```powershell
node scripts/plugin-dependencies-npx-smoke.mjs `
  --binary-directory 'G:\主代理提供的冻结目录' `
  --profile debug `
  --dist-directory 'G:\Rust\DeviceForge\frontend\dist'
```

若提供的是实际 release 构建，则明确使用 `--profile release`。`profile` 是调用者声明，不是脚本对 PE 构建属性的自动鉴定；报告保留该边界。`--dist-directory` 可省略，默认使用当前 `frontend/dist`；如主代理另提供冻结网页，则指定其真实目录。可追加 `--output-directory 'G:\尚不存在的独占证据目录'`。绝不默认读取共享 target、覆盖工作区 runtime、运行 Cargo/构建/生成器或连接用户 7031/5173/5186。

验收范围：

- 在新证据根独立组装并执行真实 `npm pack --ignore-scripts`，仅装入 `cli/bin`、`cli/src`、必要包说明、冻结 host/validator 和已构建 dist。禁止携带内置插件或工具；保存实际成员、TGZ 摘要、逐文件快照，两个缓存中的实际安装字节都须与该快照一致。npm 全程使用独占配置和离线模式，不访问在线 npm 仓库。
- 在空缓存 A、空 cwd A、业务根 A 中真实 `npx ... deviceforge start`。仅配置本地 HTTP 受信来源目录；同进程 HTTP 服务提供工具 ZIP 原字节，不启动 market exe、不绕过来源配置。
- 复用现有随机第三方 v2 发布 A：一次正常安装自动发现环境和用户目录的已有 Node，只下载缺失必需共享工具，跳过可选来源，自动绑定并启用；在此之前不调用手工 scan/install。插件本体必须以 `script+dependency` 运行，实际执行路径、父 PID、原样 argv、Node 原字节及宿主生成 marker 均核对。
- 首宿主正常退出后，换空缓存 B、空 cwd B、业务根 B，复用同一 `user/.deviceforge`。先恢复并执行 A，再正常安装不同 ID 的发布 B；B 必须使用同一共享绝对路径及摘要。第二阶段从启动到退出的来源请求严格为零，GET、HEAD 及其他方法均不允许。
- 两阶段均提交真实 HTTP POST 并调用独立 MCP 端口；第二阶段另执行实际 npm 包中的 `plugin dependencies scan` CLI，保存其逐请求、原响应与日志 ID，再核对真实终态 Job。CLI 请求记录器仅转发到实际宿主，不生成成功业务响应。
- 保存真实 dist 首页摘要、两个缓存/cwd/业务根/实际包路径不同的证据、同一用户根、每个下载请求的字节与完成状态、全部工具路径/摘要、进程身份及回收记录。宿主、CLI 监督链、内置下载源和请求记录器全部有界回收；强制回收或输入变化不能记为正常通过。没有删除失败目录或接管用户服务。

报告默认保存在 `artifacts/plugin-dependencies-npx-smoke-<profile>-<run_id>/report.json`，同目录保留 `source-requests.json`、`runtime-executions.json`、两个 `phase-*/`、实际 npm TGZ、输入与夹具前后摘要。两个阶段是同一台 Windows 主机上的独立缓存/宿主实例，不声称跨两台物理机器。真实市场、官方 HTTPS、在线 npm 发布、浏览器交互、真机、其他平台、长时和性能均不计入此项通过范围。
