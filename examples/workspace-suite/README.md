# 独立工作区前后端配套示例

本工程只使用公开 SDK、随附发行包和 `manifest.json`。复制本目录即可独立开发，不需要宿主源码、内部脚本或生成器。服务器的唯一业务是规范化消息，不访问设备、文件或网络。浏览器复用平台已经存在的文件视图，其业务继续遵循原视图的公开能力，不新增样式或产品界面。

当前已完成独立拷贝工程的真实依赖安装、前后端构建、单清单打包，以及最终归档经原运行内核装卸的直接单元。它们不等于已安装到运行中的平台，也不代表浏览器挂载、真实服务器 Job、外部 Agent 或设备验收。

## 工程与身份

`manifest.json` 是唯一维护身份、版本、组件、服务映射及市场资料的文件。开发用 `package.json` 只列语言工具和依赖，不复制插件身份。

| 项目 | 值 |
| --- | --- |
| 整体插件 | `workspace_suite` |
| 浏览器组件 | `workspace_suite.browser` |
| 服务器组件 | `workspace_suite.server` |
| 页面地址 | `/workspace-suite` |
| 页面工作区 | `workspace_suite.browser.workspace` |
| 代理视图 | `workspace_suite.browser.main` |

默认导出是接收 `{ id, version, apiVersion }` 的身份工厂。两个组件的 ID 由清单派生。手动更换整体身份时，第二插件所消费的公开契约应按兼容升级规则同步；不要只修改分发产物。

## 安装开发依赖与直接检查

需要 Node.js 22.18 或更高版本，以及 npm。进入复制后的本目录执行：

```powershell
npm install
if ($LASTEXITCODE -ne 0) { throw "安装依赖失败" }
npm run generate
if ($LASTEXITCODE -ne 0) { throw "从单清单生成契约失败" }
npm test
if ($LASTEXITCODE -ne 0) { throw "直接单元失败" }
npm run check
if ($LASTEXITCODE -ne 0) { throw "严格类型检查失败" }
```

SDK 通过 `file:./vendor/deviceforge-plugin-sdk-0.1.0.tgz` 使用真实随附包；不假设已发布到 registry。测试的 SDK 加载器也读取同一个 TGZ 内的实际 ESM，不映射宿主源码。

`npm run generate` 使用公开工具的 `generatePluginContracts`，从清单服务声明生成 `shared/service-contracts.ts`，供两端共用类型、模式和薄调用端。请修改清单后重新生成，不手改生成物。服务器的运行期输入验证、浏览器的 Job 查询与未知结果规则仍由原实现负责，生成类型不代替它们。

`npm run build:server` 使用本工程自己的 TypeScript 配置生成 `dist/server/server/entry.js`、`server/normalize.js` 和 `shared/service-contracts.js`。`npm run build:browser` 使用公开 `@deviceforge/plugin-tools` 的 `buildBrowserPlugin`，公开依赖路径来自已安装发行包的 `import.meta.resolve`，不使用宿主别名。三个构建命令均先生成契约；组合 `npm run build` 只生成一次，再完成两端构建。

本示例没有自有可见样式，不导入构建工具生成的 `styles.js`，清单只收录实际入口 `index.js`；代理文件视图继续使用原提供者的样式。真实工具 TGZ 已随附在 `vendor/`，不使用宿主内部构建脚本。构建完成后仍须使用公开 CLI 的 `plugin pack` 生成完整安装包，不能直接安装源码目录。

## 公开能力

精确版本均为 `1`：

| 类型 | 标识与行为 |
| --- | --- |
| 服务器服务 | `example.workspace.normalize`：消息规范化 |
| 浏览器服务 | `workspace_suite.browser.normalize`：提交一次并查询原 Job |
| 浏览器服务 | `workspace_suite.browser.message.read`：读取内存值和修订 |
| 浏览器服务 | `workspace_suite.browser.message.write`：按修订比较后写入 |
| 可写数据源 | `workspace_suite.browser.message`，`persistence: memory`，立即生效 |
| 自定义扩展点 | `workspace_suite.browser.tools`，消费 `{ title, commandId }` |
| 命令 | `workspace_suite.browser.tools`：读取该点的贡献目录 |
| 命令 | `workspace_suite.browser.attach`：显式追加自有视图实例 |
| 命令 | `workspace_suite.browser.replace-view`：按当前实例观测选择替换提供者 |
| 命令 | `workspace_suite.browser.restore-view`：核对替换票据与当前观测后显式恢复 |

激活登记以上能力和自有页面，并自动向精确版本的 `deviceforge_devices.tools@1` 与 `deviceforge_files.tools@1` 贡献已有文件代理视图。不调用服务器、不发设备动作，不直接改写其他插件布局。页面消费者加载后按各自公开契约自动组合；未出现时贡献等待，不要求用户添加功能。代理通过公开目录选择唯一的 `files.browser` 提供者，再用 `ui.open`、`ui.mount` 创建并挂载自己的委托实例，不选取第一个现存实例。能力缺失或有歧义时明确失败。

## 加载即跨页面贡献

安装启用后，示例视图自动进入设备与文件工作区，两个消费方拥有临时组合实例。工具没有选定设备时不补选、不派发动作；原业务页面与实例保持。停用或卸载示例，消费方撤销其工具实例并恢复原区域；文件消费方重载时只按当前贡献重建，旧贡献、实例和晚到结果不复活。此链路的原内核装卸单元已通过，不等于当前真实安装包或在线浏览器已经更新。

## 保留的显式跨页面追加命令

旧 `workspace_suite.browser.attach` 继续供插件或Agent显式调用，属于兼容入口，自动贡献流程不需要执行它。需要另外指定实例时传入已经选定的真实工作区和实例身份，例如：

```json
{
  "workspaceId": "你明确选择的设备工作区标识",
  "instanceId": "workspace_suite.browser.device-example",
  "target": {
    "kind": "device",
    "reference": {
      "providerId": "公开设备引用中的提供者标识",
      "generation": "该引用的当前代次",
      "localId": "该引用的局部设备标识"
    }
  }
}
```

字段值必须来自公开目录及明确选择，不可直接粘贴示意文字。目标工作区必须已存在，且有页面元数据表明它属于 `/devices` 或 `/files`。设备工作区必须提供完整设备引用；文件工作区也要求显式 `target`，例如确实无目标时传 `null`。不读取全局选中设备，不猜工作区或目标。

命令将原根布局整体保留为“原工作区”页签，把新实例追加为另一个页签，并保留浮窗和覆盖层。写入前再次核对原布局；冲突时只关闭本次新建实例。重名或重复添加明确失败，不覆盖原实例。

显式追加命令的持久布局继续保留其缺失占位语义，与上方由消费方管理的临时自动工具区分。重新加载不会重放旧追加命令或其他业务写入。隐藏代理实例保留视图草稿，并同步委托实例的可见性。

## 显式视图替换与恢复

从公开 `ui.snapshot()` 选定一个本套件拥有的实例，读取它的 `instanceId/workspaceId` 和当前观测；从 `ui.catalog().views` 选择明确提供者。命令不会猜第一项，也不能修改其他插件拥有的实例。

替换输入包含 `instanceId`、`workspaceId`、`expected` 和 `provider`。`expected` 为 `{ownerPluginId,generation,provider,providerGeneration,target}`，全部取自同一次当前实例观测；`provider` 为 `{pluginId,viewId,generation}`，取自当前公开视图目录。

成功返回 `replacementId/original/current` 及 `status:'selected', mount:'not_observed'`。这只确认公开选择及回读一致，**不表示视图已挂载或检查通过**，也不承诺挂载失败自动保留原视图。提供者不可用或预校验冲突不改选择；调用异常、断线或结果未知时先重新观察，不自动重放或反向覆盖。

恢复输入为 `{replacementId,instanceId,workspaceId,expected}`，其中 `expected` 使用原替换回执的 `current`，并先核对实际当前实例。若目标、代次或选择已变化，保留当前选择并返回冲突；新替换使旧票据失效，成功恢复会消费票据。插件卸载只清本代记录，不自动执行恢复或业务写入。

## 数据冲突与重载

读取服务输入 `{}`，返回 `{ value: { message: string }, revision: string }`。写入服务输入：

```json
{
  "value": { "message": "准备保存的内容" },
  "expectedRevision": "上一次读取返回的完整不透明修订"
}
```

消息最多 1000 个 Unicode 字符。不要解析或拼接修订。冲突返回 `data_source_conflict`，原内存值不变，调用方保留自己的编辑草稿，先重新读取再由用户决定如何合并。

数据只在本次浏览器插件代次的内存中。重载会产生新修订域和初始空值；旧修订不能写入新代。此示例没有持久化，也不演示自动恢复旧执行。

## 服务器协议与未知结果

服务器使用公开协议 1：stdin 读取一条 JSON 请求，EOF 后 stdout 写一条匹配版本和请求标识的 JSON 响应；stdout 不写日志。输入预算为 512 KiB，UTF-8 必须有效。`normalize` 做 NFC、去掉首尾空白并合并连续空白。

清单的 `services.provided` 把普通 `normalize` 操作映射为精确版本服务，不使用反向服务调用，也不需要协议 6 的反向帧。

浏览器先发现服务并固定提供者代次，只提交一次，然后查询原 Job 的最终状态。调用总等待上限十秒；取消只结束本地等待，不宣称服务器任务已取消。失败、断线、协议异常或提供者换代均不重放写入。已受理的等待异常保留原 Job、提交日志和最后可信日志；使用原票据查询实际结果。

## 与第二插件组合

可先加载 `workspace-contributor`：它会登记指向本插件扩展点的等待贡献，独立状态命令保持可用。再加载本套件，查看扩展点目录及第二插件状态；卸载本套件时，第二插件相关功能应撤销，其独立状态命令继续可用。

这些步骤是实际安装后的验收说明，本批尚未在运行中宿主上执行。

## 随附 SDK 身份与验证边界

`vendor/deviceforge-plugin-sdk-0.1.0.tgz`：

- 字节数：`18091`。
- SHA256：`7f58a502a553cadf19f7cf884d987f8d0e5f867af1b77299939ba6ce0db370a5`。
- 本地真实发行包，未声称 npm registry 已发布。

当前 `vendor/deviceforge-plugin-tools-0.1.1.tgz`：22640 字节，SHA256 `7b0dcc49beab4c5f7f9f3526adae5ec4853dc005bb6730a39e78f4e17fff2b9f`，同样未发布到 registry。它新增单清单契约生成；旧 `0.1.0` 文件保留但不再作为本工程依赖。已有历史制品摘要只代表对应旧输入，不代表当前源码已重新发行。

2026-10-29 已将完整工程复制到独立目录，真实执行离线依赖安装与前后端构建，再由公开 CLI 解析单清单并打包。该次 `workspace_suite-0.1.0-win32-x64.zip` 为 12300 字节，SHA256 `118cd8f1637ab2114438649bf507f5f78fd29b20be6f9f1c8f6bed4c7739c440`。该制品使用前批工具归档（14599 字节，SHA256 `fdfb3f63bb7841bdb937f2ec94c96e6a2259e1ecb739392d4214dc32dd025784`）；当前检查规则修复后未对本例重复安装构建，不能把旧制品摘要当成新构建回执。

2026-10-30 使用工具 `0.1.1` 完成新一批独立拷贝、离线安装116包、定向严格类型、契约重新生成、两端构建和公开CLI打包。新 `workspace_suite-0.1.0-win32-x64.zip` 为14779字节，SHA256 `97b60daf9b5b4f0524f7997978b28b3b2c97f86fae61d03af40444459a0d19a7`；发布修订为 `d43559e9ada923067787d944e677bcd0e61d002fb9e0a5a0b043710479f19fc6`。新旧输出分开保存，未覆盖旧ZIP。

本批最终归档直接单元9项通过、零跳过：从ZIP实际服务器组件的声明入口执行协议1的成功与非法输入；浏览器组件走原gateway/bridge/local调试链，验证统一数据发现、读写、修订冲突、卸载撤资格和旧回执隔离；原内核装卸另覆盖依赖、跨页追加与显式替换/恢复。HTTP对端、设备/文件工作区及委托视图仍为内存夹具，不是外部MCP、在线Job、实际文件视图或DOM挂载验收。

协议测试创建短期 Node 子进程并确认退出；没有启动长驻服务、浏览器或设备操作。实际安装、在线 Job 和浏览器验收继续单列。
