# 插件共享依赖

依赖属于发布元数据，不是市场卡片字段。官方、第三方、原生和脚本服务器组件使用同一契约；无依赖可声明空数组。宿主不按插件名单识别工具，不安装开发期 Cargo/npm 依赖。

## 声明与定位

独立组件包根携带 `dependencies.json`；完整功能采用 `release.json` 的 `format_version:2,host_api_version:2`，在 `dependencies` 放入同一对象。组件仍为便携 ZIP/TGZ。v1 包和安装记录保留可读兼容，不改写历史原包。

```json
{
  "format_version": 1,
  "dependencies": [{
    "id": "example-runtime",
    "name": "示例运行时",
    "version_requirement": ">=1.0.0, <2.0.0",
    "required": true,
    "entries": ["main"],
    "requires": [],
    "discovery": [
      {"kind":"environment","value":"EXAMPLE_RUNTIME_HOME","entries":{"main":"bin/runtime.exe"}},
      {"kind":"path","value":"runtime.exe","entries":{"main":"runtime.exe"}},
      {"kind":"user_directory","value":"custom/runtime","entries":{"main":"bin/runtime.exe"}}
    ],
    "probe": {"entry":"main","args":["--version"],"pattern":"runtime ([0-9]+\\.[0-9]+\\.[0-9]+)","timeout_ms":3000},
    "sources": [],
    "bindings": [{"component_id":"example-server","config_pointer":"/tools/runtime","entry":"main"}]
  }]
}
```

示例没有可信下载来源，只能发现本地运行时，不能宣称可一键下载。所有相对路径限于声明根；环境变量直接指文件时入口相对路径用 `.`。`user_directory.value` 相对后端用户根，不是当前目录或 npx 缓存。`probe.pattern` 第一个捕获组为实际版本，使用独立 argv、有限超时，不接受 shell 字符串。四段工具版本只能精确匹配或 `*`。

`requires` 引用同一声明内的配套依赖，循环声明无效。`entries` 应覆盖运行所需的 DLL、JAR、辅助程序等入口，不能只保证主 EXE 存在。完整发布的绑定必须指向其中的组件；独立组件可以省略 `component_id`，由安装身份限定。

## 正常安装与复用

### 脚本运行时

服务器组件的 `package.json.deviceforge.entrypoints` 可声明 `{"runtime":"script","path":"index.mjs","dependency":{"id":"example-runtime","entry":"main"}}`。Node 组件也可在原 `runtime:node` 上增加相同引用。依赖必须为必需项且包含该入口；独立组件从 sidecar 验证，完整发布也允许只在外层 dependencies 声明。

安装器只校验脚本文件与贡献，不要求检测前已经有解释器。宿主生成 `.deviceforge-runtime.json` 作为部署元数据；运行前从当前依赖快照解析实际可执行入口，并将脚本作为独立 argv 参数，不通过 shell。包不能自带本机绝对程序路径。缺运行时时保留待依赖部署，不能将“静态可部署”当成“脚本已可执行”。旧未引用依赖的 `runtime:node` 保留管理员 Node/PATH 兼容路径。

用户一次点击安装插件，宿主先在后端电脑检测环境变量、PATH、声明位置，再检查整个 `.deviceforge/tools` 的公共索引与声明的用户根位置。已有兼容版本直接绑定，只有缺失的必需项及其配套依赖自动下载。可选项不阻挡整个插件。启动和重新检测仅发现、验证和绑定，不擅自下载。

跨插件复用匹配稳定工具 ID、实际版本、平台和入口，不匹配安装者；不兼容版本共存。外部工具只引用，不移动、覆盖或取得删除权。卸载插件只释放自身引用，不删除其他插件仍使用的工具；显式清理仍受引用与活动租约约束。

来源含 `kind:market|official`、`url`、`platform`、实际固定 `version`、原始归档 `sha256/size`、`format:zip|tgz|file`、入口映射 `entries`。市场内容和官方内容分别固定摘要，不能复用不相同归档的摘要。只允许市场资源缺失或连接失败时尝试声明的官方 HTTPS 来源；摘要、解压和入口失败直接报告。缺少可信来源时显示缺项，不伪造地址或摘要。

工具与配置由 `DEVICEFORGE_USER_DIR` 决定，默认 `~/.deviceforge`。主 npm 包不附带工具归档。自动结果与用户保存的配置分离，SDK `resources::managed_resources()` 从 `DEVICEFORGE_PLUGIN_RESOURCES` 指向的有效快照取入口。该变量是 JSON 文件路径，不是工具目录。任意系统环境变量不会自动全部透传给插件。

新版 npx 运行包声明 `capabilities:["plugin_dependencies_v1"]`。独立组件初始 CLI 部署调用随包宿主的 `--prepare-plugin-dependencies` 模式，复用同一依赖用例、用户根及共享仓库，不启动 HTTP 监听，也不在 Node 中复制下载逻辑。旧运行包没有此能力时只保留明确的待检测提示，不能拿旧二进制冒充已自动准备。取消通过启动器回收本次整棵进程树，准备引用可能保守保留待检查，不宣称未确认的资源已清理。

## 管理接口与应用

- `GET /api/v2/plugin-dependencies/{target_kind}/{id}` 返回 `ready`、声明修订、工具来源和实际版本。
- `POST .../scan` 和 `POST .../install` 接收 `{expected_revision,dependency_ids:[]}`，返回任务，必须读取终态。空安装列表表示缺失必需项；可选项按 ID 补装。
- `target_kind` 为 `release`、`server`、`browser`。完整发布所属组件返回发布身份，不维护两套绑定。
- MCP 查询为 `deviceforge.get_plugin_dependencies`；写操作为 `dependency.scan`、`dependency.install`，与 HTTP/CLI 共用用例。
- CLI 为 `deviceforge plugin dependencies [scan|install] <target_kind> <id>`，写操作携带 `--expected-revision`，可用 `--dependency-ids` 指定补装项。

缺失必需项时插件文件仍可已安装，完整发布状态为 `dependencies_required`。下载成功后按启用意图应用，活动调用继续持有原快照；账号、设备授权、Root 和签名材料不是可下载依赖。手动路径只是高级覆盖，不是自动检测前置条件。缺少账号等业务配置仍使用 `configuration_required`，不要混淆两种状态。
