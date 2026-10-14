# 公开 SDK v2 浏览器设备工具示例

这是可用标准 npm 包部署的第三方浏览器插件，插件 ID 为 `browser_device_tools`，版本为 `0.1.0`。入口是原生 ESM `src/index.mjs`，没有运行依赖、构建步骤、宿主源码导入或面板。功能通过命令、版本化服务及逻辑钩子开放，不生成产品页面。

插件只接收公开 SDK v2 `HostContext`：普通任务使用 `listOperations/submit/getJob/cancelJob`，设备使用可选 `devices`。这里的“任务入口”是这些方法，不是一个新增的 `context.tasks` 字段。需要插件专属 `extensions.register`；较旧宿主未提供该可选扩展时激活明确失败。没有 `devices` 时，普通任务与历史查询仍可用，设备命令明确失败。

## 文件职责

| 文件 | 职责 |
| --- | --- |
| `package.json` | 在线浏览器包描述、标准打包白名单及自有测试入口 |
| `plugin.json` | 插件 ID、版本和 SDK API 版本；与默认导出保持一致 |
| `src/index.mjs` | 激活、公开资源登记和失败回滚，不装配宿主 |
| `src/input.mjs` | 本示例命令参数校验；不复制 HTTP DTO |
| `src/session.mjs` | 本次浏览器插件生命周期、公开观测、内部修订和有限 Job ID 集合 |
| `src/use-cases.mjs` | 能力查询、显式调用、任务提交和历史读取 |
| `src/contributions.mjs` | 8 个命令、2 个服务和 1 个提交前钩子的动态注册描述 |
| `tests/public-host.mjs` | 仅模拟公开 SDK 值与回调的有限测试夹具 |
| `tests/example.test.mjs` | 无定时等待的行为回归；不代替生产宿主验收 |

## 命令、服务与逻辑

下表名称均加前缀 `browser_device_tools.`。调用者必须传 `AbortSignal`。命令和服务返回公开 `HostResult`，保留所调用宿主方法的响应及日志 ID。

| 命令后缀 | 输入 | 行为 |
| --- | --- | --- |
| `catalog` | `{}` | 查询操作目录，合并本实例已收到的设备观测及有限 Job ID |
| `refresh-devices` | `{}` | 查询当前提供者与已有设备目录，不自动执行发现 |
| `discover` | `{providerId, generation}` | 显式发现指定提供者当代设备 |
| `select` | `{providerId, generation, localId}` 或 `null` | 通过完整引用选择或取消选择 |
| `invoke-read` | 公开 `DeviceAction`，见下例 | 只接受当前目录中精确版本且声明为 `read` 的能力 |
| `submit` | `{operation, input}` | 提交调用者明确选择的当前普通操作，业务 input 原样传递 |
| `get-job` | `{jobId}` | 独立查询历史 Job，不要求旧操作或提供者仍存在 |
| `cancel-job` | `{jobId}` | 显式请求服务器取消 Job |

`catalog-service` 和 `history-service` 的版本均为精确的 `1.0.0`，分别对应 `catalog`、`get-job`。其他插件可用公开 `extensions.callService` 消费；宿主可用 `runtime.extensions.callService`。服务撤销后应重新读取贡献目录，旧代已经绑定的调用不能因同 ID 重载而复活；再次按 ID/版本发起新调用会解析当时的新代服务，不把 ID 字符串视为永久失效引用。

`require-current-operation` 是 `beforeTaskSubmit` 钩子，优先级为 `0`。启用期间，每次经过宿主任务提交链的提交都会重新查询公开操作目录；操作缺失则停止此次提交，不进入 HTTP 提交。钩子保留原 `operation/input`，不注入预算、设备身份或私有字段。这实际增加了宿主提交规则，也会增加一次目录查询；查询失败同样停止提交。多钩子的排序和失败停止由宿主注册表负责，不由本示例另建链路。

示例命名空间是 `browser_device_tools.catalog` 状态和 `browser_device_tools.changed` 事件。状态属于本插件所有者；跨插件读取使用服务，通知使用公开事件订阅，不绕过宿主所有权规则读取别人的状态。

## 能力驱动与历史边界

设备名称或平台字符串不能唯一定位设备。命令使用 `providerId/generation/localId`；动作的设备字段为 `deviceId`，提供者作用域传 `null`。能力从当前 `provider.definition.capabilities` 选择，必须精确匹配 `id/version`。示例只允许 `access: 'read'`；设备可用性、状态、作用域与引用有效性继续由公开 SDK/宿主验证。`read` 是提供者声明，不是对可信代码副作用的安全保证。

可与现有 [Node 设备提供者示例](../../backend/examples/device-provider-node/README.md) 配合：该包声明 `synthetic_demo`、`provider.describe` 和 `device.echo`，不是平台真机适配。先由宿主启用服务器提供者，再查询设备目录，使用返回的真实 ID、generation、能力及引用；本插件没有硬编码这些模拟能力或任何平台工具路径。

普通操作的可选 `execution.apiVersion/totalTimeoutMs/source` 和设备能力的可选 `executionTimeoutMs` 仅通过目录透传供读取。缺省元数据不猜测补值；本示例没有客户端预算覆盖入口。设备动作顶层额外字段会拒绝；普通业务 input 保持调用者的业务对象含义，不把其中字段解释为宿主预算。

提供者撤销或换代通知到达时，本实例取消绑定旧 `id/generation` 的等待。即使调用忽略信号且稍后返回，也不会把旧响应的 Job 登记到本实例。新代必须从新目录显式取得；浏览器插件卸载取消其生命周期，撤销动态贡献和订阅。示例内部 `runId` 与 `revisions` 只是本次激活标记和本地观测修订，不能当作服务器 generation 或目录修订。

历史按 Job ID 查询，原样保留 `result/error/status`。协议 2/3 的 `result + artifacts` 包装仍在公开 Job 的 result 中；不因当前目录更新为历史补写预算、rawState 或设备引用。本实例只保存最多 32 个已交付 Job ID，不提供持久历史列表。卸载会清空该集合，但不删除服务器历史、不自动取消已接受的 Job，也不把宿主共享设备选择当作本插件私有资源清空。

## 标准打包与在线启停

以下命令由主代理在工程根目录执行；本轮交接未运行。Node 22 及以上仅用于自有测试与打包，浏览器入口不导入 Node 模块。无需安装依赖，无需构建，使用标准 `npm pack`，不复制通用 TAR 实现。

```powershell
npm test --prefix examples/browser-device-tools
npm pack ./examples/browser-device-tools --ignore-scripts --pack-destination ./artifacts
```

标准包名为 `deviceforge-browser-device-tools-example-0.1.0.tgz`。解包后根为 `package/`，描述读取 `package.json` 中 `deviceforge`，再读取 `plugin.json`；入口为 `src/index.mjs`。`tests/` 随包保留开发回归，但生产入口不导入测试文件。`private: true` 用于避免误发布到 npm registry，不影响本地打包。

宿主通过生产公开 ESM `/assets/plugin-host.js` 的 `createFrontendRuntime` 装配运行实例。当前产品 `main.ts` 未自动装配该实例，也没有安装/操作页面；以下是已有 runtime 的接入示例，不是产品 UI。`tgz` 是宿主已取得的归档 `Blob`，`signal` 是宿主生命周期内的调用信号：

```js
// 这些管理入口属于宿主 app，不是插件获得的 HostContext。
await runtime.pluginPackages.upload('browser', tgz, 'application/gzip', signal);
await runtime.pluginPackages.refresh('browser', signal);
await runtime.pluginPackages.enable('browser', 'browser_device_tools', signal);

const reply = await runtime.extensions.executeCommand(
  'browser_device_tools.catalog', {}, signal);
const history = await runtime.extensions.callService(
  'browser_device_tools.history-service', '1.0.0', { jobId }, signal);

await runtime.pluginPackages.disable('browser', 'browser_device_tools', signal);
// 可再次 enable 创建新的浏览器插件代次；remove 先停本实例再删除部署。
await runtime.pluginPackages.remove('browser', 'browser_device_tools', signal);
```

上传仅部署，启用才执行。包的相对 ESM 依赖由宿主每次加载的运行 UUID 路径共同承载，不自行给入口附查询参数以冒充依赖图换代。停用后命令/服务/钩子撤销；其他浏览器实例不会被此实例删除部署强制停止，已经执行的 ESM 内存也不能由浏览器强行卸出。取消管理等待后，应由宿主重查实际部署状态，不假设事务回滚。

插件没有服务器插件管理、包管理或产物上传下载 SDK。需要产物时，由宿主现有入口上传后把产物 ID 放入能力所约定的业务 input；不提供服务器路径。插件不读取服务令牌、localStorage、任意 URL 或宿主私有模块。

## 公开消费示例

以下代码属于已获公开上下文的消费者或宿主开发者。先显式读取当前目录，再发现指定提供者；发现回执与当前接受目录的区别沿用宿主语义，不把任意 Job 成功结果重建为当前观测。

```js
const execute = (name, input) => runtime.extensions.executeCommand(
  'browser_device_tools.' + name, input, signal);
await execute('refresh-devices', {});
const catalog = (await execute('catalog', {})).data;
const provider = catalog.devices?.providers.find((entry) =>
  entry.definition.capabilities.some((capability) =>
    capability.scope === 'device' && capability.access === 'read'));
if (!provider) throw new Error('当前目录没有可供示例调用的只读设备提供者');
await execute('discover', { providerId: provider.id, generation: provider.generation });

// 引用和能力来自当前接受目录；不使用名称、平台字符串或历史 Job 猜测引用。
const current = (await execute('catalog', {})).data;
const directory = current.devices?.directories.find((entry) =>
  entry.provider.id === provider.id && entry.provider.generation === provider.generation);
const device = directory?.devices.find((entry) => entry.capabilities.some((available) =>
  available.available && directory.provider.definition.capabilities.some((capability) =>
    capability.id === available.id && capability.version === available.version
      && capability.scope === 'device' && capability.access === 'read')));
const capability = directory?.provider.definition.capabilities.find((entry) =>
  entry.scope === 'device' && entry.access === 'read' && device?.capabilities.some((available) =>
    available.available && available.id === entry.id && available.version === entry.version));
if (!device || !capability) throw new Error('当前目录没有可用的精确只读能力');
await execute('select', device.reference);
const job = await execute('invoke-read', {
  providerId: device.reference.providerId, generation: device.reference.generation,
  deviceId: device.reference.localId, capability: capability.id, version: capability.version,
  input: businessInput,
});
const historical = await execute('get-job', { jobId: job.data.id });
```

`businessInput` 必须按所选能力约定提供，不根据展示标题猜测参数。提供者作用域能力可以直接调用 `invoke-read`，但 `deviceId` 必须为 `null`。普通任务则显式传 `{operation: chosenOperationId, input: businessInput}` 给 `submit`；操作来自目录，参数满足其 `input_schema`。不自动选择并提交未知操作，不后台轮询任务或设备。

日志 ID 沿公开 `HostResult/HostError` 传递，不把 Job ID、runId、本地修订或私造字符串当服务器日志。`catalog.logId` 来自此次操作目录查询；设备内容来自本实例已有观测，因此组合结果不是服务器原子快照，日志 ID 不代表其中每个设备观测的来源。`select` 是本地状态操作，返回 `logId: null`。本地参数错误使用 `example_*` 错误码，不伪造服务器 `HostError` 或日志 ID。

客户端 Abort 取消等待，不等于服务器 Job 已取消，也不撤销已接受提交。要请求服务器取消，显式调用 `cancel-job` 并继续按 Job ID 查询状态。宿主能及时停止等待忽略信号的回调；可信插件自己的副作用无法强制中断，资源登记和卸载取消不能证明外部清理完成。

## 交接验收项与未执行范围

本示例新增 7 项有限测试，使用可手动释放的 Promise 门闩，不用长 sleep。测试夹具只模拟公开值与回调，`fake-*` 日志、提供者与 Job 都是模拟数据，不是实际服务器日志或生产验收证据。测试不复刻生产 registry，因此真实 `HostError` 包装、取消及时性和所有权门禁仍由主代理真实宿主验收。

| 编号 | 自有回归目标 | 生产浏览器需追加核对 |
| --- | --- | --- |
| EX-01 | 描述、清单、默认导出、版本及 ESM 相对入口一致 | 标准 TGZ 在线上传成功，生产 host 启用并加载完整相对依赖图 |
| EX-02 | `devices` 缺省时任务和历史可用，设备入口明确失败 | 实际生产上下文按可选扩展消费，不读取私有模块 |
| EX-03 | 同名设备按完整引用区分，能力精确版本及 read 限制，拒绝额外预算字段 | 命令调用正确提供者；实际 SDK 继续校验作用域、状态与可用性 |
| EX-04 | 提供者换代在途取消，晚返回不登记旧 Job，新代显式恢复 | 真实提供者卸载/重载后目录与入口撤销，实际旧引用被拒绝 |
| EX-05 | 目录撤销后历史读取不变，不补当前元数据 | 任务完成后卸载提供者，原 Job 历史仍按公开接口读取 |
| EX-06 | 钩子实际阻止缺失操作提交，解除登记后宿主流程恢复 | 在生产 tasks 提交链中验证钩子启用/停用，服务器接受记录与拒绝一致 |
| EX-07 | 晚到查询不覆盖新通知；释放订阅/动态登记并拒绝旧实例服务回调 | 停用/重载/删除后贡献、事件和状态收敛，新实例从新代开始 |

主代理验证顺序建议为本目录全部 `.mjs` 语法门禁、自有测试、标准打包、在线上传/启用、命令/服务/钩子消费、停用/重载和删除。实际报告需要记录包与生产 host 摘要、浏览器版本、服务器日志 ID、启动/退出及清理失败证据；普通缺陷按上述验收项回流，打包或激活阻断立即回流。真实浏览器 harness 属于后续另行分配写集，本示例不修改任何既有验收脚本。

本轮仅交付源码、清单、测试与说明，未执行 Node/npm/Cargo、构建、打包、服务或浏览器。静态路径/编码核对不能证明语法、标准包安装或运行行为通过；其他批次的测试和 release 报告不计为本示例通过。没有验证 Android/Harmony/iOS 真机、平台迁出、常驻性能会话、产品 UI、长时执行或分发兼容。

公开契约参见 [插件开发](../../frontend/docs/guides/插件开发.md)、[在线插件与开放扩展](../../frontend/docs/implementation/在线插件与开放扩展.md)、[设备能力与插件面板](../../frontend/docs/implementation/设备能力与插件面板.md) 和 [普通操作总期限消费契约](../../frontend/docs/contracts/普通操作总期限消费契约.md)。这些文档描述宿主已有边界；本示例不冻结或扩充 HTTP/SDK 契约。
