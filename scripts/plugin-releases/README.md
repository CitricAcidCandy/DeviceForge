# 插件发布与统一安装

模式为 architecture-first，验证采用 Hybrid。发布层组合已构建的便携插件包和已核验工具，不编译、执行插件或读取用户实际配置。运行时安装统一交给服务器公开 API。

## 冻结格式

权威契约为 `backend/docs/contracts/统一插件安装v1.md` 及领域 `plugin_installations` 类型。清单使用 `format_version:1`、`host_api_version:2`，包含中文 name、description、components、tools 和 requirements。

官方 `backend/plugins/*/release.json` 是源码依赖声明：空 variants 表示尚未构建或核验，工具版本 `unresolved` 表示必须由真实输入补齐，不可用于成品发布。打包必须满足全部目标平台组件和必需工具；可选工具未提供时略过，提供后仍严格校验摘要、大小、归档及入口。账号、设备权限、项目与签名材料属于用户输入，不作为下载工具。

用户输入requirements使用`component_id`、`config_pointer`、`title`、`description`，可选`required`默认true、`sensitive`默认false。可再提供`any_of`额外JSON Pointer数组：同一组件的主指针或任一额外指针已配置，即满足这一条输入要求；不同必需requirements仍须分别满足。额外指针最多16项，每项与主指针遵守相同的有界JSON Pointer规则，禁止重复（含与主指针重复）。省略或空数组保持旧的单指针行为；Rust序列化在默认空数组时省略该字段。服务端读取配置原值执行门禁，敏感字段的遮蔽字符串不作为已配置凭据。

工具供应源码声明示例：

```json
{
  "component_id": "tool-supply",
  "config_pointer": "/local_manifest",
  "any_of": ["/manifest_url"],
  "title": "工具供应清单",
  "description": "选择本地或远端清单来源。",
  "required": true
}
```

该OR门禁与表单的来源互斥校验分别执行：填任一合法来源可满足必需输入，同时填写两种来源仍不符合工具供应模式。`repository_mode:managed`使用服务器共享仓库，`install_root`可为null或省略，不再列为统一发布必需输入；`custom`及省略模式的旧配置仍必须提供实际绝对安装根，具体资格由配置模式和插件运行读取继续校验。工具供应没有来源的便携默认值只表达未配置，不能据模式默认值有效就宣称已启用。

统一发布描述由 `officialDependencies.description` 提供：必需工具自动准备和绑定，用户填写项目、认证、设备权限与签名等业务条件，可选工具缺失仅影响相应能力。旧独立包 `market.json` 保持原部署语义；生成在线发布目录时使用统一发布清单的 description，避免市场继续展示需单独准备必需工具的旧说明。

源码组件和工具版本也可使用常用 SemVer 范围，例如 `^1.2.0`、`~1.2.0`、`>=1.2.0 <2.0.0`、`1.x`、`1.2.0 - 1.9.0` 与 `||`。发布器使用固定的 `semver@7.8.5`，按标准规则比较且不会隐式接受预发布版本；范围不能替代实际输入版本。组件以归档内 `package.json` 和插件清单中一致的固定版本锁定，输入另填 version 时也须完全相同；工具输入必须显式填写已核验固定 version，不能回退到声明。原有 `5.0.0.71` 等非 SemVer 厂商固定标识继续精确比较。成品拒绝范围和 `unresolved`，未提供的可选工具从成品省略；资源仍按实际字节计算摘要，原始归档不会改写。

最终离线格式为 ZIP，根目录包含 `release.json`，归档资源位于 `blobs/<sha256>`。在线发布另生成清单，path 改为资源服务路径下的相对摘要，两个清单分别计算原字节 SHA-256，不混用修订。

## 单元职责

| 单元                     | 职责                             | 不承担              | 副作用                  |
| ------------------------ | -------------------------------- | ------------------- | ----------------------- |
| contract                 | 清单规则、平台选择、摘要去重     | 网络、解包          | 无                      |
| versions                 | 源码范围匹配与成品固定版本门禁   | 在线解析版本、下载  | 无                      |
| io                       | 普通文件大小与流式摘要           | 安装                | 只读文件                |
| archive                  | 有界 ZIP/TGZ 检查和离线归档      | 编译、执行          | 本轮输出                |
| templates                | 官方公开模板便携化与机器路径门禁 | 覆盖用户配置        | 无                      |
| pack                     | 组件、工具闭包编排和报告         | 网络、运行工具      | 新输出目录              |
| publish                  | 资源去重上传和最后目录提交       | 安装、启用          | 显式 publish 时远端写入 |
| official                 | 十八份官方依赖声明与覆盖报告     | 伪造归档、凭据      | 显式生成源码声明        |
| cli/plugin-installations | API上传、提交与任务等待          | Rust校验器、npm脚本 | HTTP                    |

## 本地打包

首次使用开发期发布脚本前安装其独立锁定依赖：

```powershell
npm ci --prefix scripts/plugin-releases --ignore-scripts
```

该依赖只供本地发布脚本使用，不进入 CLI 的运行依赖或 npm 分发文件。

```powershell
node scripts/pack-plugin-release.mjs pack --source backend/plugins/mirroring/release.json --inputs artifacts/plugin-release-candidates-20261022/mirroring-inputs.json --destination artifacts/my-mirroring-release --platform win32-x64
```

inputs 只接受 components、tools 两个对象，键必须已在源码清单声明。每项填写 file、platform、format，可提供预期 sha256、size。工具必须另填真实固定 version 和 entries，组件 version 可由归档锁定；十八份输入生成器会显式写入组件固定 version。file 相对 inputs 文件解析，永不写进发布清单。工具完整目录所需 DLL、许可证和资源须包含在归档中；单个 EXE 不能冒充完整 SDK。输出目录必须不存在。

## 十八份官方组件统一构包

库存生成器只校验已经取得的固定工具字节和入口，不下载或执行工具：

```powershell
node scripts/plugin-releases/tool-inventory.mjs artifacts/plugin-release-candidates-20261022
```

已有库存为 `artifacts/plugin-release-candidates-20261022/tool-inventory.json`，不可覆盖；需要重验时通过导出的 `writeToolInventory` 选择新的库存路径。库存收录九个工具身份、八份去重归档，明确列出六项可选缺失工具。

`official-batch-01`已经真实完成，十八份TGZ与ZIP及独立流式分发核验均保留在该目录。随后`tool-process/src/pty/windows.rs`源码晚于第一批EXE发生变化，第一批是历史候选，不能当作当前源码的最终交付。其生产依赖会影响ai-assistant、ai-sdk、android-device、android-packages、automation、frida、harmony-device、mirroring、terminal九项，宿主也受影响。

第二批已经在此前主代理冻结源码并释放共享Cargo后完成，现为工具供应门禁修复前的历史候选。实际执行命令如下；该输出目录现已存在，不能覆盖本批或第一批：

```powershell
node scripts/plugin-releases/build-official-releases.mjs artifacts/plugin-release-candidates-20261022/official-batch-02 artifacts/plugin-release-candidates-20261022/licensed-tool-candidates-01/tool-inventory-ascii.json
```

此命令使用 `packNativePlugins` 的 `-j 1` 原生 release 构建和真实校验器，冻结 `native-results.json`，生成十八份 `inputs/<真实插件ID>.json`，逐包生成最终 ZIP 并重新核验目录摘要和每份工具入口，最后写 `build-report.json`。中途失败保留现场，仅完整成功报告 `complete:true`。目录与插件ID不同的三项分别是 `artifact-copy → artifact_copy`、`cooperative-demo → cooperative_demo`、`performance-demo → performance_demo`；选择和输入键均以真实清单身份为准。目录验证不替代新宿主实际安装、市场与设备验收。

2026-10-22 23:15:52 +08:00启动的第二批Cargo使用release、`-j 1`，编译8分56秒，构包脚本退出0。十八ZIP合计695109876字节。独立脚本`verify-official-releases.py`流式重读全部ZIP资源、十八原始TGZ、实际EXE及最终ZIP嵌入TGZ中的EXE，并逐项对应批准库存；结果为passed。身份清单与机器报告分别为`official-batch-02/release-inventory.md`、`official-batch-02/distribution-verification.json`；输入库存SHA-256为`0a0ca0f1c1e2fb071fbb0d9c6ba312acd9ebfe6382f202d9a0bd762b86e25488`。核验命令如下，只为新批次首次生成核验报告，既有报告保留：

```powershell
py -3.12 -X utf8 scripts/plugin-releases/verify-official-releases.py artifacts/plugin-release-candidates-20261022/official-batch-02 artifacts/plugin-release-candidates-20261022/licensed-tool-candidates-01/tool-inventory-ascii.json
```

独立核验脚本的报告status与Markdown标题自2026-10-23起按输入目录`root.name`生成，例如`official-batch-03`；本次仅移除“第二批”展示硬编码，摘要、资源、EXE、库存及分发边界校验保持不变。旧批次报告原字节保留，不因脚本展示调整而改写。

2026-10-23已授权修复工具供应来源二选一与managed空根门禁，`tool-supply/release.json`按更新后的官方声明单独再生成，其他源码发布清单保持不动。后端修复冻结、API生成完成且主代理释放共享Cargo后，第三批已获授权使用相同ASCII库存构建。外层于00:20:52 +08:00启动，Cargo于00:20:54启动，release编译4分26秒，构包脚本于00:26:13正常退出0。实际命令如下；目录已经存在，不得覆盖：

```powershell
node scripts/plugin-releases/build-official-releases.mjs artifacts/plugin-release-candidates-20261022/official-batch-03 artifacts/plugin-release-candidates-20261022/licensed-tool-candidates-01/tool-inventory-ascii.json
```

第三批十八ZIP合计695110864字节；独立核验实际重读十八ZIP、十八原始TGZ、十八EXE及ZIP内嵌TGZ中的EXE，逐项校验九工具库存，全部通过。报告为`official-batch-03/distribution-verification.json`、`release-inventory.md`；`build-source-evidence.json`与`build-source-recheck.json`记录十二份已知修复来源均早于Cargo启动且摘要保持不变。该范围只覆盖已列修复来源，完整源码冻结与最终门禁由主代理负责。

本批核验时捕获的宿主候选为27266048字节、SHA-256 `149d0684314118b63d08b40f318aa06ab2134a8ee7ea52f000499aaa3876eb97`；校验器为6159872字节、SHA-256 `fc24c146cfa68be1dca97a6d6c2401e7e24e3d01aaac0645672f62c892e757e9`。主代理正在执行完整后端门禁，最终宿主运行身份须以其后续报告为准。旧批次宿主和浏览器结果不转计第三批。

第三批`packaged-configuration-audit.json`直接读取最终ZIP内组件：十八项均有中文外显名称、非空描述和版本化配置；十二项有六十个根字段，六项无需配置；发布用户输入十七条，其中八条必需、一个替代来源指针，工具引用与绑定各十三条。`packaged-schema-verification.json`记录已有Ajv8.20.0验证十八份实际成品默认值和工具供应十四个分支场景全部通过；其中`password`为界面展示格式，未另作为字符串值约束。工具供应已实际入包`any_of:["/manifest_url"]`、managed空安装根和custom绝对根分支。

经主代理授权，本批另使用`planPublication`顺序生成十八份`publication-plans/<插件ID>.json`，每份包含`summary`、`entry`、在线`manifest`及`manifest_sha256`，目标地址为`http://127.0.0.1:7040`；`publication-plans-report.json`和`publication-plans-verification.json`记录完整数量、摘要回读及外显元数据核验通过。生成过程只有本地读写，未调用`publishRelease`或访问远端，`remote_written:false`；最终离线ZIP保持原字节。市场实际写入、第三批在线/断网安装、配置启用/调用、浏览器和npx继续由主代理按最终字节验收；库存仍为`redistribution_ready:false`。

如组件已经由主代理单独冻结，可只生成输入：

```powershell
node scripts/plugin-releases/prepare-official-inputs.mjs 本轮native-results.json artifacts/plugin-release-candidates-20261022/licensed-tool-candidates-01/tool-inventory-ascii.json 新输入目录
```

冻结结果必须包含完整十八项 `{id,version,archive,size}`，可另含 SHA-256；脚本重新读取实际组件身份、入口、大小、摘要及工具闭包，全部通过后才生成输入目录。

官方投屏包会在暂存副本内设置 `configuration.defaults.live.server_version=3.3.4`、相对资源名 `scrcpy-server`，并同步公开模板。宿主随后按 resources.json overlay 成真实绝对路径。用户已有显式绝对路径优先，源 TGZ 和现有配置不修改。AI 的项目、认证、会话目录、设置插件的存储根及工具供应的来源，在发布暂存中使用 `null` 表达尚未配置，必需发布输入阻止未配置时启用。工具供应managed模式的安装根为null表示由宿主管理，暂存会保留custom分支的绝对根要求。不会用构建机器路径或示例项目代替真实配置。Android Simpleperf 与 Frida 服务使用明确的设备内路径，按固定插件/字段白名单保留，不能用作主机工具入口。其余机器绝对路径仍拒绝发布。

统一发布的组件、工具与配置归服务器`DEVICEFORGE_USER_DIR`或默认用户根；`--data-dir`仅选择业务数据和兼容部署目录。`APK_ADB`、`APK_HDC`与旧插件旁置工具配置保留为兼容入口。发布安装中已托管的可选APK工具会在有效配置快照中按资源声明自动补齐`kind`，已有用户值优先；使用自定义工具路径时仍需填写与该工具匹配的`kind`。源码清单中的历史requirements提示不代表托管安装后还要重复手填这些可推导字段。

## 工具许可证补充候选

`prepare-licensed-tools.py`只读原库存，另建工具候选和新的`tool-inventory.json`，不运行Cargo、设备工具或发布远端。使用Python3.12运行，并选择不存在的输出目录：

```powershell
py -3.12 -X utf8 scripts/plugin-releases/prepare-licensed-tools.py artifacts/plugin-release-candidates-20261022/tool-inventory.json artifacts/plugin-release-candidates-20261022/新的许可证候选目录
```

脚本按scrcpy v3.3.4的版本构建脚本取得许可证、依赖源码与摘要；补充同版本Codex主LICENSE/NOTICE及HDC来源材料。所有原始工具成员逐项复验字节保留，原包和第一批ZIP不覆盖。scrcpy-server另建含Apache许可的跨平台ZIP，入口为`scrcpy-server`；清单格式改为zip而实际server字节不变。其余未变化工具在新库存中以相对路径继续引用原文件。

成功生成补充候选不等于再分发条件全部完成。真实下载失败、源码摘要不符会记录；不可用材料不伪造。HDC的公开二进制来源及对应libusb源码、Codex语音组件中微软运行库的分发资格、LGPL源码与替换/重新链接条件仍按最终分发方式核对。候选库存显式标记`redistribution_ready:false`，主代理据实际剩余条件决定后续构包与发布，不能把它称为已公开发布或已全部许可。

2026-10-22实际补充候选的可用库存为`artifacts/plugin-release-candidates-20261022/licensed-tool-candidates-01/tool-inventory-ascii.json`，四份改包均通过发布器实际摘要、归档和入口复验，详见同目录`publisher-verification.json`和`冻结输入与分发边界.md`。该目录初版`tool-inventory.json`的Codex中文TAR文件名触发PAX头而被安全门禁拒绝，原样保留作失败证据，不用于下一批；修正包使用ASCII说明文件名与中文正文。

## 计划与发布

```powershell
node scripts/pack-plugin-release.mjs plan --directory artifacts/my-mirroring-release --market backend/plugins/mirroring/market.json --server http://127.0.0.1:7040
node scripts/pack-plugin-release.mjs publish --directory artifacts/my-mirroring-release --market backend/plugins/mirroring/market.json --server http://127.0.0.1:7040
```

plan 只读本地完整闭包，输出来源三重身份、资源数量和分类转换，不访问远端。publish 再核验实际字节，HEAD 核对已有 SHA 和长度，缺失才流式上传，release.json 最后上传，catalog 最后提交。任一资源失败不发布目录，不自动覆盖已有 ID/version。旧官方业务分类 device/utility 显式映射为资源服务允许的 function，并在计划中列出前后值。

发布器使用既有资源服务 `/api/v1/resources` 和 `/api/v1/catalog`，该服务响应是普通 JSON；统一安装 API 使用 v2 日志包装。两者不会混用协议。

## CLI

```powershell
deviceforge plugin install .\mirroring-0.1.0-win32-x64.zip --api-url http://127.0.0.1:7030
deviceforge plugin install https://market.example/api/v1/resources/实际摘要 --release-id mirroring --release-version 0.1.0 --manifest-sha256 实际摘要
deviceforge plugin update mirroring .\update.zip --expected-revision 旧清单SHA256
deviceforge plugin list --api-url http://127.0.0.1:7030
deviceforge plugin cleanup --api-url http://127.0.0.1:7030
deviceforge plugin cleanup --dry-run false --api-url http://127.0.0.1:7030
```

离线先流式 `POST /api/v2/plugin-installations/artifacts?filename=...`，然后与在线相同调用 `POST /api/v2/plugin-installations`，请求 `{source,expected_revision:null}`，更新为 `PUT /api/v2/plugin-installations/<id>`。来源沿用领域 market/offline 类型。接收202 Job后轮询 `/api/v2/jobs/<id>`，核对每次日志ID；成功仅在 succeeded 返回。Ctrl+C 仅结束等待，不自动重放、撤销或卸载服务器任务。等待默认十分钟，单次请求三十秒；APK_API_TOKEN 仅用于请求头。

旧目录/npm/TGZ安装显式使用 `plugin install-legacy`；旧本地目录列表使用 `plugin list-legacy`。新安装客户端不依赖同包 Rust 校验器。

`cleanup` 默认只预览，经 `POST /api/v2/plugin-installations/cleanup` 提交 `installation.cleanup` 任务并等待真实终态；显式 `--dry-run false` 才执行服务器清理。服务器选择未被引用的资源，CLI 不接收任意路径和调用端数据目录。成功输出完整 `ResourceCleanupReport`，会检查模式、每项长度和总字节数一致。

## 验证边界

独立测试执行 `node --test scripts/tests/plugin-releases.test.mjs cli/tests/plugin-installations.test.mjs`。真实本地候选与上游来源摘要在 `artifacts/plugin-release-candidates-20261022/`。JS规则、受控HTTP和本地候选通过不等于新宿主真实安装、正式市场发布、真机或跨平台验收。
