# 插件发布与统一安装

模式为 architecture-first，验证采用 Hybrid。发布层组合已构建的便携插件包和已核验工具，不编译、执行插件或读取用户实际配置。运行时安装统一交给服务器公开 API。

## 冻结格式

权威契约为 `backend/docs/contracts/统一插件安装v1.md` 及领域 `plugin_installations` 类型。清单使用 `format_version:1`、`host_api_version:2`，包含中文 name、description、components、tools 和 requirements。

官方 `backend/plugins/*/release.json` 是源码依赖声明：空 variants 表示尚未构建或核验，工具版本 `unresolved` 表示必须由真实输入补齐，不可用于成品发布。打包必须满足全部目标平台组件和必需工具；可选工具未提供时略过，提供后仍严格校验摘要、大小、归档及入口。账号、设备权限、项目与签名材料属于用户输入，不作为下载工具。

最终离线格式为 ZIP，根目录包含 `release.json`，归档资源位于 `blobs/<sha256>`。在线发布另生成清单，path 改为资源服务路径下的相对摘要，两个清单分别计算原字节 SHA-256，不混用修订。

## 单元职责

| 单元                     | 职责                             | 不承担              | 副作用                  |
| ------------------------ | -------------------------------- | ------------------- | ----------------------- |
| contract                 | 清单规则、平台选择、摘要去重     | 网络、解包          | 无                      |
| io                       | 普通文件大小与流式摘要           | 安装                | 只读文件                |
| archive                  | 有界 ZIP/TGZ 检查和离线归档      | 编译、执行          | 本轮输出                |
| templates                | 官方公开模板便携化与机器路径门禁 | 覆盖用户配置        | 无                      |
| pack                     | 组件、工具闭包编排和报告         | 网络、运行工具      | 新输出目录              |
| publish                  | 资源去重上传和最后目录提交       | 安装、启用          | 显式 publish 时远端写入 |
| official                 | 十八份官方依赖声明与覆盖报告     | 伪造归档、凭据      | 显式生成源码声明        |
| cli/plugin-installations | API上传、提交与任务等待          | Rust校验器、npm脚本 | HTTP                    |

## 本地打包

```powershell
node scripts/pack-plugin-release.mjs pack --source backend/plugins/mirroring/release.json --inputs artifacts/plugin-release-candidates-20261022/mirroring-inputs.json --destination artifacts/my-mirroring-release --platform win32-x64
```

inputs 只接受 components、tools 两个对象，键必须已在源码清单声明。每项填写 file、platform、format，可提供预期 sha256、size。工具另填真实 version 和 entries。file 相对 inputs 文件解析，永不写进发布清单。工具完整目录所需 DLL、许可证和资源须包含在归档中；单个 EXE 不能冒充完整 SDK。输出目录必须不存在。

官方投屏包会在暂存副本内设置 `configuration.defaults.live.server_version=3.3.4`、相对资源名 `scrcpy-server`，并同步公开模板。宿主随后按 resources.json overlay 成真实绝对路径。用户已有显式绝对路径优先，源 TGZ 和现有配置不修改。其他含机器绝对路径的默认值或公开模板会拒绝发布，要求源码先修正。

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
```

离线先流式 `POST /api/v2/plugin-installations/artifacts?filename=...`，然后与在线相同调用 `POST /api/v2/plugin-installations`，请求 `{source,expected_revision:null}`，更新为 `PUT /api/v2/plugin-installations/<id>`。来源沿用领域 market/offline 类型。接收202 Job后轮询 `/api/v2/jobs/<id>`，核对每次日志ID；成功仅在 succeeded 返回。Ctrl+C 仅结束等待，不自动重放、撤销或卸载服务器任务。等待默认十分钟，单次请求三十秒；APK_API_TOKEN 仅用于请求头。

旧目录/npm/TGZ安装显式使用 `plugin install-legacy`；旧本地目录列表使用 `plugin list-legacy`。新安装客户端不依赖同包 Rust 校验器。

## 验证边界

独立测试执行 `node --test scripts/tests/plugin-releases.test.mjs cli/tests/plugin-installations.test.mjs`。真实本地候选与上游来源摘要在 `artifacts/plugin-release-candidates-20261022/`。JS规则、受控HTTP和本地候选通过不等于新宿主真实安装、正式市场发布、真机或跨平台验收。
