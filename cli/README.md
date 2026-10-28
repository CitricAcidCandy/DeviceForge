# DeviceForge 启动与服务器插件安装

CLI 只负责分发边界，不复制设备业务。`bin/deviceforge.mjs` 是入口；src/options 解析参数；root-config-schema 校验根配置，root-config 管理有界读写与原子发布；marketplace 校验市场来源；network 生成监听及 Host/Origin；start 管理生命周期；web-server 提供静态资源和固定后端流式代理；processes 管理进程；runtime/paths 校验运行包；install、plugin-package、plugin-files 分别编排安装、解析便携清单与受限复制。

## 使用

## 插件开发：只维护一份清单

独立工程只维护 `manifest.json`（`manifest_version:1`）：顶层功能身份、名称和描述，`components` 中的服务器／浏览器入口与公开能力，`dependencies` 和必要本地 `dependency_files`，以及可选 `market` 展示资料。组件版本默认继承功能版本，单组件 ID 默认继承功能 ID，多组件默认为 `<功能ID>.<kind>`。自己的语言工程文件继续负责构建，不重复维护 DeviceForge 资料。

```powershell
deviceforge plugin pack manifest.json --out dist-plugin --platform win32-x64
deviceforge plugin plan dist-plugin --server http://127.0.0.1:7040
deviceforge plugin publish dist-plugin --server http://127.0.0.1:7040
```

使用包含上述命令的 CLI 发行包；也可通过部署者提供的本地 CLI TGZ 用 npx 调用，不假设已公开发布 npm。pack 不构建源码、不运行插件、不启动服务，不改源工程；默认读取当前 manifest.json，输出 dist-plugin，新输出目录的父目录须存在，既有输出不覆盖。组件便携清单、市场资料、依赖、TGZ、release.json、真实摘要和完整离线 ZIP 自动生成。浏览器可导出身份工厂 `({id}) => ({panels:[]})`，包装入口自动注入 id/version/apiVersion。

plan 只读本地闭包，不访问远端。publish 显式写入指定资源服务，先核对能力，再按资源、在线清单、catalog 顺序提交，读取生成 market.json 而无需再传另一份声明。资源摘要只在最终字节确定后计算，不要求手填。旧安装格式及旧发布脚本继续可用；本功能不把现有已安装插件自动迁移或覆盖。

market 可声明 summary、keywords、categories、applies_to、supports_mcp、supports_agent、restart_policy、author、license、homepage、visibility、details；id/version/name/description 从顶层派生。完整字段和示例由 MCP `get_plugin_development_guide` 的 manifest 主题直接提供，打包流程在 packaging 主题提供，不需要开发者获取项目源码。

## 运行与安装

服务器插件和浏览器插件配置统一写入用户 `~/.deviceforge/plugin-configurations/`，分别位于 `server/<插件ID>/` 与 `browser/<插件ID>/`。该位置独立于插件程序、npm 缓存和业务数据目录；`--data-dir` 不改变插件配置归属。需要隔离部署或测试时可显式设置 `DEVICEFORGE_USER_DIR` 指向独立用户根。浏览器插件通过当前服务器保存配置，因此局域网客户端共享该服务器所属用户的配置。

旧业务目录内的配置修订和插件旁置配置仅在用户目录不存在对应配置时复制，原文件保留。已存在的用户配置优先，不被随包默认值或旧目录覆盖。浏览器旧 localStorage 在首次没有服务端记录时导入，之后保存必须由服务器确认成功。

在根目录执行 `npm run prepare:runtime` 构建当前平台 release 运行包，随后 `npm pack --pack-destination artifacts`。生成的 tgz 携带 Rust 宿主、插件校验器和前端资源，使用者只需 Node.js/npm，无需 Rust。资源服务由部署者独立启动和维护，其源码与程序均不进入 npx 包。发布 npm 后可使用 `npx @deviceforge/cli start`；当前没有发布 registry，验收与使用应指定本地打包 tgz：

```powershell
npx --yes --package .\artifacts\deviceforge-cli-0.1.0.tgz deviceforge --help
# 本地和局域网默认免鉴权；需要鉴权时再配置 APK_API_TOKEN。
npx --yes --package .\artifacts\deviceforge-cli-0.1.0.tgz deviceforge start --ip 0.0.0.0 --port 7030 --mcp-port 7032
npx --yes --package .\artifacts\deviceforge-cli-0.1.0.tgz deviceforge start --marketplace-url http://192.168.50.5:7040
npx --yes --package .\artifacts\deviceforge-cli-0.1.0.tgz deviceforge plugin install .\my-release.zip --api-url http://127.0.0.1:7030
```

默认绑定 0.0.0.0；--ip 接受 IPv4/IPv6 字面量。前端/API 默认 7030，独立 MCP 默认 7032，端口不能相同。MCP 端口仅提供 /mcp，前端端口也可代理 /mcp；两者共用 Rust 任务。本地和局域网默认免鉴权，未配置或显式空字符串 APK_API_TOKEN 都按空令牌启动，不自动生成随机令牌。可选配置非空令牌时不得包含空白，客户端以 Bearer 使用 API；CLI 不打印令牌、不把它放入 HTML 或代客户端注入。具体业务界面和令牌输入交互等待前端设计。

业务数据默认 ~/.deviceforge，可由 --data-dir 或 DEVICEFORGE_DATA_DIR 配置。统一发布的组件、共享工具与插件配置使用服务器用户根，由 DEVICEFORGE_USER_DIR 或默认用户目录决定，不随 --data-dir 移动，也不写入 npm 缓存。旧独立插件目录 data-dir/plugins、部署 APK_PLUGIN_DIR 和工具变量 APK_ADB/APK_HDC 等仅作兼容入口；统一安装按发布清单自动准备并绑定工具。相对 APK_PLUGIN_DIR 按 CLI 当前工作目录解析，兼容安装、列举和启动共用该位置，Rust 接收绝对路径。

错误的 Host 被拒绝，MCP Origin 按实际网卡与两端口生成；未支持任意自定义域名。市场默认地址为 `http://127.0.0.1:7040`，可用 `--marketplace-url http://服务器地址:7040` 直接覆盖，或使用 `--marketplace-config .\marketplace.json` 读取 `{ "sources": [{ "name": "团队市场", "url": "https://market.example.com" }] }`，两参数互斥。来源仅注入启动环境，浏览器地址覆盖由设置页按当前浏览器保存。资源服务未启动或地址暂不可达不阻塞宿主启动，退出启动器也不会停止独立资源服务。

Ctrl+C/SIGTERM、启动失败或后端异常退出时停止对外监听与本次进程。正常停止先通过本次回环后端的 system/shutdown 接口收敛任务/会话并刷新日志，最多等待 5 秒；超时才强制清理本次服务树。就绪探测和内部关闭只在配置非空令牌时发送 Authorization；空令牌部署也可直接调用 system/shutdown 让 npx 正常退出。默认日志写入 data-dir/logs，启动输出日志位置；DEVICEFORGE_LOG_DIR 可调整，相对值按 CLI 工作目录解析。设备操作不会自动回滚，外部设备进程需单独验收。

## 用户目录与根配置

Windows 的默认用户根为 `%USERPROFILE%\.deviceforge`（例如 `C:\Users\用户名\.deviceforge`），其他系统为 `~/.deviceforge`，可通过 `DEVICEFORGE_USER_DIR` 显式选择。统一发布的组件、工具和插件配置固定归属该服务器用户根；隔离部署或测试时须为服务器选择独立的用户根。

业务数据目录另按 `--data-dir`、`DEVICEFORGE_DATA_DIR`、默认用户目录的优先级选择；它不改变统一发布资源与插件配置的归属。换启动目录、退出或重新下载 npx 程序都不会主动删除持久目录。显式指定的业务数据目录继续独立，不自动合并项目预览目录或其他实例。

首次启动创建 `config.json`，后续启动自动读取；启动参数覆盖根配置但只作用于本次运行，不静默保存。根配置只管理监听和市场默认来源，格式如下：

```json
{
  "format_version": 1,
  "server": { "ip": "0.0.0.0", "port": 7030, "mcp_port": 7032 },
  "marketplace": { "sources": [{ "name": "本地默认市场", "url": "http://127.0.0.1:7040" }] }
}
```

`server` 和 `marketplace` 可省略以使用默认值。拒绝未知字段、未知版本、坏端口、相同端口和含凭证的市场地址；文件上限 64 KiB，接受 UTF-8 BOM，不在错误中透传原始 JSON。令牌仍通过 `APK_API_TOKEN` 可选提供，不写根配置。

```powershell
deviceforge config path
deviceforge config show
deviceforge config import .\my-config.json
deviceforge start --data-dir D:\DeviceForgeData
```

导入先校验，再在同卷临时文件中写入并替换；多个写入者通过 `config.json.lock` 互斥。无效导入保留原配置。异常进程留下的锁需核对后处理，不自动删除未知锁。导入只改变下次启动偏好，不重启已有服务，不覆盖插件、工具、任务或业务配置。`show/path/help` 不创建用户目录。

旧独立服务器与浏览器插件的兼容部署目录分别为业务数据目录下的 `plugins`、`browser-plugins`，可由 `APK_PLUGIN_DIR`、`APK_BROWSER_PLUGIN_DIR` 覆盖；日志和任务数据沿既有存储布局，`DEVICEFORGE_LOG_DIR` 继续生效。统一发布使用用户根下的组件与共享工具仓库，插件配置位于 `plugin-configurations`。工具供应的托管模式复用共享仓库；旧自定义供应模式仍使用显式 `install_root`，不会静默迁移部署者已有工具。不要把兼容目录或 `install_root` 当作统一发布资源的目标目录。

页面的“本地导入”直接把合规服务器/浏览器插件安装到当前服务，并通过工具供应和配置接口导入工具包、业务配置或插件配置；它与“上传资源并发布”分开，不依赖市场可用。根启动配置使用上面的 CLI 导入命令，业务配置和插件配置分别遵循各自修订与生效机制。安装文件通过包校验不代表工具已在真实设备或目标平台运行验收。

## 统一插件安装

`plugin install` 和 `plugin update` 调用正在运行的服务，统一处理 `release.json` URL 或自包含离线 ZIP；`plugin list` 返回同一服务的公开安装视图。`--api-url` 默认为 `DEVICEFORGE_API_URL` 或 `http://127.0.0.1:7030`，不会启动第二个服务器。安装位置由服务器用户根决定；调用端的 `--data-dir` 不选择远端安装位置，服务器自己的 `--data-dir` 也不改变统一发布组件、工具与配置的用户根。

```powershell
deviceforge plugin install .\mirroring-0.1.0-win32-x64.zip --api-url http://127.0.0.1:7030
deviceforge plugin install https://market.example/api/v1/resources/实际摘要 --release-id mirroring --release-version 0.1.0 --manifest-sha256 实际摘要
deviceforge plugin update mirroring .\update.zip --expected-revision 旧清单SHA256
deviceforge plugin list --api-url http://127.0.0.1:7030
deviceforge plugin cleanup --api-url http://127.0.0.1:7030
deviceforge plugin cleanup --dry-run false --api-url http://127.0.0.1:7030
```

URL 来源须同时提供发布 ID、版本和清单原字节 SHA-256；离线 ZIP 不混用这些市场参数。离线先流式上传到 `POST /api/v2/plugin-installations/artifacts?filename=...`，随后与在线来源共用安装 API。客户端接受不超过 4 GiB 的普通 ZIP，服务器仍独立执行完整清单、依赖、摘要与入口验证。更新须携带实际旧修订，避免覆盖并发修改。新安装客户端不依赖 CLI 自带的 Rust 校验器，不执行 npm 脚本。

接收 202 任务后，CLI 等待 `succeeded` 才报告完成；失败和取消均返回错误。默认单请求 30 秒、整个等待 10 分钟，Ctrl+C 只结束本地等待，已经提交的任务可在任务页继续查看。每次响应核对日志 ID，可选令牌仅发送到请求头。安装后的启用状态由服务返回决定；必要账号、项目、签名或路径输入不足时，在市场补齐配置。更新保留已有配置，发行包不得带用户凭据。

`plugin cleanup` 调用 `POST /api/v2/plugin-installations/cleanup`，默认提交 `dry_run:true` 预览未引用的缓存与展开资源。显式 `--dry-run false` 才执行清理；服务器决定可回收集合并保留被安装记录引用的资源，CLI 不接收任意删除路径或 `--data-dir`。客户端等待 `installation.cleanup` 任务成功后输出 `dry_run`、`items`、`total_bytes` 和关联任务/日志 ID；202 本身不代表清理完成。

发布者通过 `node scripts/pack-plugin-release.mjs pack` 组合真实插件包和工具依赖；`plan` 只核验本地闭包，`publish` 才上传资源并最后写市场目录。完整格式、输入说明和命令见 [发布层说明](../scripts/plugin-releases/README.md)。源码 `release.json` 的空变体不能作为可安装成品，缺少必需工具或真实摘要会阻止打包。

## 兼容服务器插件包

`plugin install-legacy` 接受本地目录、本地 .tgz、npm 包名及可选版本；不接受任意 URL、Git 地址或 shell 指令。安装禁用 npm 生命周期脚本，保留 npm 已解析的依赖布局。包依赖若必须执行原生 postinstall，应由开发者预编译后发布。安装本地目录要求它已具备运行依赖。

包根 package.json 增加：

```json
{
  "name": "example-deviceforge-plugin",
  "version": "1.0.0",
  "deviceforge": {
    "kind": "server",
    "manifest": "plugin.json",
    "entrypoints": {
      "win32-x64": { "runtime": "native", "path": "bin/plugin.exe" },
      "any": { "runtime": "node", "path": "entry.mjs" }
    }
  }
}
```

plugin.json 使用公开 SDK 清单字段 id/version/protocol_version/args/operations 以及可选 artifacts/performance/devices，省略 executable；入口由安装器生成绝对路径。Node 入口使用当前 Node 程序，native 使用声明平台程序。版本必须与 npm 包一致，入口必须为包内非链接普通文件。

插件名称、简介和详细描述使用包根的 `market.json`，不写入运行清单。安装器校验它的 ID、版本与展示字段后，将同份资料发布到插件部署根；即使 npm 入口位于 `node_modules` 内，宿主也能在市场离线时读取本地展示资料。缺少资料的旧包仍可本地安装，页面会提示资料不完整。三个展示字段分别最多 200、2000、20000 个 UTF-8 字节，中文同样按字节计量。

工作区原生插件通过 `npm run pack:plugins -- 插件ID` 打包，生成的 TGZ 包含插件入口、便携清单、`market.json` 和已声明的公开配置模板。宿主依据 `configuration` 声明提供配置表单；实际配置、凭据和部署机器上的 ADB、scrcpy 等依赖工具不随这些模板打包。

安装先复制到发布目录同卷的独立暂存区，限制 256 MiB、20000 文件、32 层，拒绝链接；再调用同包 Rust validate-plugin 校验协议、能力、命名空间与输入模式，最后原子 rename 发布。该门禁不执行插件代码。相同 ID 拒绝覆盖，同 ID 安装锁拒绝并发；失败或取消清理本次暂存/锁，崩溃遗留锁需要部署者检查处理。依赖获取阶段没有磁盘硬配额，管理员应控制 npm 源与包信任。

`plugin list-legacy` 返回旧本地部署清单概要。兼容安装可在服务运行中执行，原子发布后通过 POST /api/v2/plugins/{id}/load 或 MCP deviceforge.load_plugin 显式加载；配置令牌时请求须携带鉴权。/unload 或 deviceforge.unload_plugin 撤销贡献、取消并等待任务。部署文件保留，历史任务保留，重新加载生成新代际；受保护性能探针拒绝卸载。CLI 尚无专门的 load/unload/remove 子命令；兼容安装不支持同 ID 原地更新，统一发布使用前述 `plugin update`。

在线 HTTP 另提供服务器/浏览器包上传、目录及部署删除，浏览器生产宿主支持动态模块加载和热装卸，见 [在线插件接口](../backend/docs/contracts/在线插件接口.md)。在线目录只列在线安装元数据，不等同于 plugin list 或运行中插件目录；CLI 安装的旧部署不自动进入在线目录。删除已加载服务器包须先卸载；删除浏览器包只移除服务器文件，其他浏览器已执行的代码由各实例自行停用。组件自身的业务模块仍须随包携带；运行工具通过公开 dependencies 声明，先自动发现再只下载缺失必需项。离散设备提供者及其热装卸已实现，常驻设备会话和平台工具迁出仍待实施。

## 历史验收与发布边界

`npm test` 覆盖参数、网络、路径/来源、安装拒绝、实际 Rust 门禁、真实 HTTP/MCP、取消和端口冲突；`npm run smoke:cli` 打包并通过真实 npx 安装 tgz 插件，再验证依赖、禁用安装脚本、插件任务及本机/局域网地址。静态服务验收不等于页面视觉审核，未改变前端业务页面。

当前 Windows x64 release 运行包已重建，根 npm test 15 项通过。真实 npx 使用同一 tgz 分两阶段验证显式令牌和默认无令牌 0.0.0.0 启动、HTTP/MCP 日志 ID、五个原生插件、Node 依赖、热装卸及正常关闭/端口释放。本阶段另实际安装公开设备示例，经 HTTP/MCP 发现和能力调用、重载换代与旧引用精确拒绝，完整任务及事件历史保持一致；没有验证另一台主机或真机。后续修改启动边界仍须先重建 runtime，再运行测试，不能以旧 Rust 包替代当前源码验证。

公共工具执行库回接阶段已重新构建 release 并完成同一 tgz 的真实 npx 两阶段验收，包含协议 2/3 嵌套产物插件。此包包含有界直接进程回收与宿主未确认状态守卫；实际 Android/Harmony 平台实现、常驻会话和性能热卸载仍待迁出，不以示例验收代替。

当前 npx 验收另实际安装协议 2/3 的嵌套产物提供者，检查最终 manifest.json 中的 input_pointers 保留，并通过 HTTP/独立 MCP 核对宿主副本、JSON 输出原字节、摘要、在途卸载及新旧代引用。成功和取消任务保留，原成功任务及事件在换代后保持一致。报告位于 artifacts/nested-device-artifacts-smoke-npx.json；这些 CLI 部署不自动进入在线安装元数据目录。

当前运行包仅包含构建主机的平台。发布前需分别构建 Windows/Linux/macOS 的目标程序并组成平台包或平台矩阵，不能把 Windows 验收写成跨平台验证。--debug 仅用于开发验收；默认 prepare:runtime 使用 release。registry 发布、下载来源签名、其他平台与另一台局域网客户端验收单独跟踪。

## 统一依赖与初始部署

新版运行包声明 capabilities 中的 plugin_dependencies_v1。独立初始 `plugin install` 在文件部署后调用随包宿主的依赖准备模式，不启动监听；宿主先收集环境与整个 `.deviceforge` 共享工具，兼容直接复用，仅下载缺失必需项。完整发布与运行中组件安装复用同一用例。手动路径不是前置要求，主 npm 包不带工具归档，保存位置由 DEVICEFORGE_USER_DIR 决定。

依赖准备失败不会删除已部署程序或破坏原有工具。CLI 返回 dependencies_required 或真实准备失败提示；可在管理页补救。旧运行包不具备新宿主能力时明确返回 host_check_required，不调用旧程序不支持的子命令，也不宣称工具已就绪。取消会回收本次整棵准备进程树，未确认的准备引用保守保留待检查。

读取和补救仍可使用 `deviceforge plugin dependencies server <id>`、`deviceforge plugin dependencies scan server <id> --expected-revision <sha>` 和 `deviceforge plugin dependencies install release <id> --expected-revision <sha> --dependency-ids <id>`。写操作查询终态，不重放 POST。启动等待含插件完整性验证，有界上限 120 秒，不再沿用空宿主十五秒门限。当前平台与本次实际构建/验收以最新交付记录为准，前节是历史证据。
