# Harmony 核心设备插件实施裁定

日期：2026-10-10。状态：主代理已批准最小迁移范围，本文作为下一批实现冻结依据。模式为 architecture-first，验证采用 Hybrid：先做公开契约、纯输入拒绝和无副作用失败，再做独立假 HDC、宿主撤除、debug/release 分发与真实设备验收。

## 目标与边界

本批把宿主内置 Harmony 的核心离散业务迁移到独立 `harmony-device` 插件。只迁出设备发现、应用列表、HAP 安装和应用卸载四项贡献；不增加公开 SDK，不修改通用 HTTP/MCP 路由，不把宿主残余实现复制到插件外。

发现不是设备能力。其余三项为 API 3、版本 1 的 device 能力：

| 短贡献 | 完整 ID | scope/access | 总预算 |
| --- | --- | --- | --- |
| `discover` | `plugin.harmony-device.discover` | 发现入口 | 30000 毫秒 |
| `packages` | `plugin.harmony-device.packages` | device/read | 30000 毫秒 |
| `app.install` | `plugin.harmony-device.app.install` | device/write | 120000 毫秒 |
| `app.uninstall` | `plugin.harmony-device.app.uninstall` | device/write | 120000 毫秒 |

旧能力 `harmony.devices` 通过绑定指向发现入口，不能作为清单能力重复声明。旧 Electron 中的降级安装、保留数据卸载、应用详情、ability 推导、启动、停止、重置、远程连接、重启、端口转发、设备信息和亮灭屏列入后续业务批，不以四项迁移扩大为完整 Harmony 支持。

## 责任边界

| 单元 | 负责 | 不负责 |
| --- | --- | --- |
| `harmony-device` 插件 | HDC 参数、发现解析、HAP 输入副本、应用列表/安装/卸载结果、插件私有资源 | HTTP/MCP 路由、宿主任务表、统一设备锁、ArtifactStore 实体生成 |
| 宿主设备目录与任务层 | provider/设备身份、代次、能力可用性、排队、取消、同设备写互斥、产物归档 | 平台命令构造、HDC 文本解析、HAP 私有副本 |
| `tool-process` 与 `plugin-runtime` | 有界进程、协议 4 上下文、合作取消、直接进程退出确认 | HDC 子命令语义、共享 HDC daemon 生命周期 |
| 部署者 | HDC 入口、共享 daemon、远程连接和设备授权 | 插件请求传入工具路径或任意 shell |

插件不导入宿主 `domain/application/infrastructure/server`。宿主撤除 `HarmonyDeviceTools` 与 `RemainingDeviceArtifactActions` 后，无插件部署仍能启动；无绑定时不回退到内置 Harmony 操作。

## 清单、输入与绑定

清单使用协议 4、设备 API 3、平台 `harmony`，声明 `ArtifactAccess` 的输入指针为 `/input/artifact_id`，不声明顶层输入字段。两个清单文件必须逐字节一致；运行时只接受四个短贡献名，误发完整 ID、未知字段、缺失字段和额外字段均在配置、目录、文件与 HDC 之前拒绝。

设备封套固定为 `{device_id, input}`：`device_id` 是保留原文的有效 serial，`input` 严格按贡献解析。`packages` 使用 `{device_id, input:{}}`；安装使用 `{device_id, input:{artifact_id}}`；卸载使用 `{device_id, input:{package}}`。provider 发现只接受 `{}`，不伪造设备封套。

格式 2 绑定至少包含：

- `harmony.devices` → `device_discovery`，输入为 identity，结果为 platform=`harmony` 的发现数组；
- `harmony.packages` → `device_capability` `packages@1`，`device_envelope`，value 投影；
- `harmony.app.install` → `device_capability` `app.install@1`，`device_envelope`，value 投影并保留 `artifact_id`；
- `harmony.app.uninstall` → `device_capability` `app.uninstall@1`，`device_envelope`，value 投影。

绑定缺失、目标代次不匹配或插件未加载时返回宿主精确错误，不调用旧内置执行器。

## HDC 与发现兼容

部署配置旁置于插件二进制的 `harmony-device.config.json`，严格格式 1，仅允许 `tools.hdc` 和可选绝对 `scratch_root`；`--config` 只接受一个绝对配置路径。HDC 入口只能是单一程序名或无父路径的绝对普通文件，业务请求不能覆盖入口。缺省旁置配置不存在等于空配置并返回固定依赖错误，显式缺失配置失败。

发现固定执行 `hdc list targets`。输出按行去除首尾空白，允许空行和精确的 `[Empty]` 哨兵；其它每一行都必须是一个有效、唯一、最多 200 字节的设备标识，最多 128 台。任一控制字符、非法标识、重复标识、超限或未知诊断行使整次发现失败，不返回部分目录。此处是有意的兼容收紧：旧 `parse_hdc` 会跳过任意方括号行和非法标识，新插件只保留已知 `[Empty]` 哨兵，拒绝静默丢失设备或诊断。

每个合法 HDC 标识映射为 `PluginDevice`：`state=online`、`raw_state="device"`、`model=null`，并声明 `packages@1`、`app.install@1`、`app.uninstall@1` 三项可用能力。发现只记录本次观测，不承诺常驻事件、设备事务回滚或调用时仍在线。

## 业务行为与失败边界

安装只接受唯一 `/input/artifact_id` 授权行，ID 必须是标准连字符 UUID；显示名必须为单文件名并以 `.hap`（大小写不敏感）结尾，大小不超过 64 MiB。输入源及全部祖先必须是无链接、无重解析点的普通绝对路径；复制到本次私有目录的固定 `input.hap`，按声明大小和真实读取字节流式核对 SHA-256，关闭并复核副本后才启动 HDC。

安装 argv 固定为 `-t serial install <私有input.hap>`。HDC 零退出、UTF-8 输出、两流均无失败诊断且某个独立行以 `msg:install bundle successfully.` 精确结尾（大小写无关）才算成功；兼容真实客户端的 `[Info]App install path:<path> msg:install bundle successfully.` 前缀。stderr 失败、非零退出、超限、非 UTF-8、缺少成功片段或取消/到期均返回固定错误，不暴露失败原始工具文本。返回 value 为 `{artifact_id,output}`，私有路径替换为显示文件名。

卸载先校验最多 200 字节的点分 ASCII 包名，argv 固定为 `-t serial uninstall package`。只有零退出、两流均无失败诊断且某个独立行以 `msg:uninstall bundle successfully.` 精确结尾（大小写无关）才成功，保留真实客户端信息前缀并返回 `{output}`；不申请保留数据、降级或测试包权限。

应用列表 argv 固定为 `-t serial shell bm dump -a`。成功返回去除首尾空白的 `{output}`；HDC 诊断、非零退出、非 UTF-8、超限、取消或到期均返回固定依赖/上下文错误，不返回部分文本。所有业务输入先纯校验，工具启动前不读取无关产物、不创建宿主输出实体。

## 资源所有权与截止点

每次调用从协议 4 `InvocationContext` 取得唯一本地截止点 `D_L`；排队、配置读取、HAP 副本、HDC、结果处理和清理按原始总预算执行，阶段不得续期。取消或到期固定同一次清理点 `C`（最多两秒），清理不得借用 `D_L` 继续业务，也不得重新取得 `C`。

插件每次最多一个阻塞文件 worker；worker 持 semaphore、私有目录 lease、实际文件句柄和只读取消回调至真实返回。Future 被丢弃、worker panic、文件 flush/关闭未确认、直接进程清理失败或清理点耗尽时设置粘性未确认，保留私有目录并报告 `cleanup=failed`。目录删除必须实际成功且收到不存在确认后才能 `cleanup=complete`，无 Drop 删除、后台重试或隐式扩大窗口。

HDC 直接进程使用公开带 lease 的工具入口；插件只确认本次子进程和私有资源，不杀共享 HDC daemon，不执行全局 disconnect 或 kill-server。宿主统一设备写锁覆盖安装和卸载；插件退出不代表设备状态回滚或其它用户连接关闭。

## 最小验收

1. 架构脚本确认插件无宿主反向依赖、清单逐字节一致、空插件部署可启动，宿主不再直接装配 Harmony 四项。
2. Rust 单测覆盖严格封套、UUID/HAP/包名、发现 `[Empty]` 哨兵、非法/重复/超限整份失败、HDC 固定 argv、成功行和 stderr/退出失败边界。
3. 独立协议测试使用假 HDC，证明安装副本字节与 SHA-256、私有路径遮蔽、应用列表输出、取消/到期、Future 丢弃、panic、目录保留与 cleanup 结果；不把假 HDC 当真机证据。
4. 设备提供者 smoke 覆盖 HTTP/MCP 同一 provider、发现/能力可用性、共享写锁、旧代拒绝、热装卸和无内置回退；debug 与 release 包分别执行，npx 消费正式包。
5. 真机验收另取 HDC 实机证据，分别记录设备授权、应用安装/卸载、包列表、断线和工具失败；不得以旧宿主测试、模拟 HDC 或源码静态检查代替。

## 交接与写集

本批插件实现写集为 `backend/plugins/harmony-device/` 及本裁定文档；测试助手独占该插件 `tests/` 与 Harmony smoke 夹具。主代理独占 workspace/Cargo.lock、宿主撤除、架构脚本、生成器、根 todo、服务、debug/release 构建和分发验证。未执行 Cargo、格式、服务或真机前，不记录为通过。

后续业务批按迁移清单另行冻结，不在本批加入详情/ability、启动/停止、重置、远程连接、设备信息、屏幕控制、降级安装或保留数据卸载。
