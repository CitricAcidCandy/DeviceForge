# 浏览器公开 SDK v2

## 错误反馈面向实际使用者

先直接说明已确认的问题，再给出下一步建议；不能用“任务失败”、HTTP 状态或日志编号代替原因。错误原文、代码和任务／请求日志归属保留在技术详情，不展开请求体、凭据或任意底层工具输出。

插件更新后旧设备信息失效，应显示“设备插件已更新，当前设备信息已过期”，可让用户主动刷新页面；普通资源占用、应用未安装或连接工具失败不能都解释成页面升级。取消等待不代表后台任务已经取消，网络断开也不代表写操作没有生效；应提醒先查任务状态，不自动刷新、不自动重放。旧服务术语由宿主反馈层兼容解释，不修改原错误码和历史日志。插件自行提供的错误文字也应遵守此规则，不以内部名词或堆栈替代具体原因。

可选 `context.services` 提供精确引用调用、类型化调用、功能级依赖和诊断；`services.server.list/submit` 访问服务器目录与共享 Job，任务继续使用 `getJob/cancelJob`。本主题直接给出公开签名；功能级等待、撤销与清理查询 `lifecycle`，完整消费方查询 `examples`，均通过 MCP 获取正文。

插件默认导出 `{ id, version, apiVersion: 2, panels, activate?, deactivate?, contributions? }`。`activate(context)` 返回 `Promise<void>`；`deactivate` 与所有释放函数的类型为 `() => void | Promise<void>`。`panels` 必填，允许空数组。不要导入宿主私有实现；下述类型与签名已经包含开发所需的公开边界。

## HostContext 基础

```typescript
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type Dispose = () => void | Promise<void>;
interface HostResult<T> { readonly data: T; readonly logId: string | null }
interface Operation {
  readonly id: string;
  readonly title: string;
  readonly input_schema: JsonValue;
  readonly execution?: { readonly apiVersion: 1; readonly totalTimeoutMs: number; readonly source: 'default' | 'declared' };
}
interface Job {
  readonly id: string;
  readonly operation: string;
  readonly status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  readonly result: JsonValue;
  readonly error: string | null;
}
interface HostContext {
  readonly apiVersion: 2;
  readonly signal: AbortSignal;
  readonly services?: ServiceAccess;
  listOperations(signal: AbortSignal): Promise<HostResult<readonly Operation[]>>;
  submit(operation: string, input: JsonValue, signal: AbortSignal): Promise<HostResult<Job>>;
  getJob(id: string, signal: AbortSignal): Promise<HostResult<Job>>;
  cancelJob(id: string, signal: AbortSignal): Promise<HostResult<Job>>;
  subscribeOperations(listener: (items: readonly Operation[]) => void): Dispose;
  onDispose(dispose: Dispose): Dispose;
}
```

`HostContext` 另有可选 `extensions/devices/artifacts/taskHistory/themes/configuration`，旧宿主或独立装配可省略，必须先判断。SDK 通常采用 camelCase，`Operation.input_schema` 则保留该公开字段名；不要自行将 SDK 参数变成 HTTP snake_case。`execution` 只描述当前操作总预算，不允许浏览器覆盖预算，也不用于给历史任务补写元数据。

## 公共服务与功能级组合

以下签名直接包含在 MCP 返回正文中，不要求远端开发者访问仓库文件。`services` 是 SDK v2 的可选扩展；不需要新建“组合插件”类别，旧 `extensions.callService(id,version,input,signal)` 继续兼容。

```typescript
interface ServiceRef { readonly id: string; readonly version: string }
interface ServiceContract { readonly inputSchema: JsonValue; readonly outputSchema: JsonValue }
interface ServiceDirectoryEntry {
  readonly service: ServiceRef;
  readonly contract: ServiceContract;
  readonly operation: string | null;
  readonly provider: { readonly id: string; readonly version: string; readonly generation: string };
  readonly available: boolean;
  readonly reason: string | null;
}
interface ServerServiceAccess {
  list(signal: AbortSignal): Promise<HostResult<readonly ServiceDirectoryEntry[]>>;
  submit(ref: ServiceRef, input: JsonValue, signal: AbortSignal, generation?: string): Promise<HostResult<Job>>;
}
interface TypedService<I extends JsonValue, O extends JsonValue> extends ServiceRef {
  readonly accepts: (value: unknown) => value is I;
  readonly returns: (value: unknown) => value is O;
}
interface ServiceFeatureDiagnostic {
  readonly featureId: string;
  readonly state: 'waiting' | 'starting' | 'active' | 'failed' | 'stopped';
  readonly missing: readonly ServiceRef[];
  readonly error: string | null;
  readonly cleanupErrors: readonly { readonly registration: number; readonly revision: number; readonly message: string }[];
}
interface ServiceAccess {
  readonly server?: ServerServiceAccess;
  catalog(): readonly ServiceDirectoryEntry[];
  call(ref: ServiceRef, input: JsonValue, signal: AbortSignal): Promise<HostResult<JsonValue>>;
  callTyped<I extends JsonValue, O extends JsonValue>(ref: TypedService<I, O>, input: I, signal: AbortSignal): Promise<HostResult<O>>;
  whenAvailable(featureId: string, required: readonly ServiceRef[], setup: (feature: HostContext) => void | Dispose | Promise<void | Dispose>): Dispose;
  diagnostics(): readonly ServiceFeatureDiagnostic[];
}
```

- 服务 `version` 是精确字符串，例如 `'1'` 与 `'1.0'` 不等价，不做版本范围解析或数字转换。`provider.generation` 只标识当前提供者代际，重载后须重新读取目录。
- `catalog()` 读取浏览器服务，`server.list(signal)` 读取后端服务，两者不是同一个调用通道。未激活浏览器提供者可诊断为 `available=false,reason='provider_not_active'`，不可提前调用。目录存在不等于业务一定成功。
- 浏览器服务贡献可加 `inputSchema/outputSchema`；宿主在调用前后校验。旧贡献省略时兼容任意 JSON。`callTyped()` 还调用消费方提供的 `accepts/returns` 类型守卫，不能用 TypeScript 类型断言替代运行时验证。
- `whenAvailable()` 只观察浏览器服务依赖，立即返回已纳入插件资源管理的撤销函数；不要在 `activate()` 中等待提供者永远出现。同一插件内 `featureId` 应唯一，空依赖数组可用于独立功能。
- `setup` 使用收到的 `feature` 上下文注册命令、模块、槽位及清理资源，不捕获根上下文登记这些贡献。提供者缺失、版本不匹配、卸载或换代只撤销相关功能；恢复后新建子作用域，其他功能继续运行。完整可执行消费方见 `examples` 主题的 `service-consumer.mjs`。
- `server.submit()` 返回现有异步 Job，而不是服务输出。继续用 `getJob()` 查询终态，需要停止时显式 `cancelJob()`；浏览器取消等待不保证已接受的后端任务被取消。传入 `generation` 可拒绝已换代提供者。
- 嵌套浏览器服务和命令转调继承调用链的取消与期限，深度上限 8、每根最多 4 个活动后代，递归明确拒绝。需要让功能跟随目录变化时使用 `whenAvailable()`，不能保存旧代上下文后自行复活。

## 扩展贡献

所有界面 `mount(target, context)` 返回 `Promise<Dispose>`。使用本次挂载收到的上下文，退出挂载时即可撤销子作用域。`panels` 项为 `{id,title,mount}`；可选 `contributions` 的字段如下：

| 字段 | 结构或签名 |
| --- | --- |
| `components` | `{id,title,slot,mode?: 'append'或'replace',mount}` |
| `modules` | `{id,title,route,mount}`，`route` 为宿主路径（`/catalog`），派生出插件页面与侧栏「插件」分组条目 |
| `commands` | `{id,title,execute(input,context,signal): Promise<HostResult<JsonValue>>}` |
| `services` | `{id,version,inputSchema?,outputSchema?,invoke(input,context,signal): Promise<HostResult<JsonValue>>}` |
| `beforeTaskSubmit` | `{id,priority?,transform({operation,input},context,signal): Promise<{operation,input}>}` |
| `themes` | `{id,title,variables?: Record<string,string>,css?: string,colorScheme?: 'light'或'dark'或'normal'}` |

组件只在已开放的具名槽位生效。宿主把槽位的可用模式在装配处写死，插件无法自我授权：`replace` 由槽位适配器管理默认内容的释放与恢复，`append` 只往后追加。当前产品开放的槽位：

| 槽位 | 形态 | 允许模式 |
| --- | --- | --- |
| `route.<路由>` | 整页替换宿主页面，如 `route.performance` | `replace` + `append` |
| `route.marketplace`、`route.settings` | 卸载与自救入口，受保护 | 仅 `append` |
| `page.<插件ID>.<页面>` | 插件模块自己的页面，由 `modules[].route` 派生 | `replace` |
| `devices.apps` | 设备工作台右栏「应用」页签的内部区域 | `replace` + `append` |
| `settings.plugin.section` | 设置页末尾的插件分组 | 仅 `append` |
| `workshop.extensions` | 旧版工作区插槽，保持兼容 | `replace` + `append` |

槽位标识只接受小写字母、数字与 `.` `_` `-`，最长 64 字符；大小写或中文都会先归一成这两条规矩下的字符串（`My Page` → `my-page`），所以插件模块的 `route` 应写成宿主路径（`/catalog`），页面槽位即 `page.<插件ID>.catalog`，地址栏是 `#/plugin/<插件ID>/catalog`。

接管是**热拔插**的：实际挂载成功才隐藏宿主默认内容，挂载等待或失败时保留默认内容，卸载即回落，页面代码不需要知道插件存在。接管期间槽位顶部有一条 28px 来源条（插件标题 + 等宽插件 ID +「恢复默认」）；「恢复默认」只写本地忽略表并回落到宿主内容，不卸载插件、不改配置。挂载失败时换成琥珀降级条，宿主内容照常显示。

模块路由按插件命名空间判重，不同插件均可声明 `/catalog`；同一插件的 `/a/b` 与 `/a-b` 归一后页面键相同会被拒绝。启动目录尚未就绪时保留插件页面直达地址，确认页面不存在或卸载后才回到设备页。当前公开能力可接管业务页面，不提供完整替换导航、顶栏和整个产品外壳的接口；市场和设置仍只允许追加。

写错槽位名不会静默成功：宿主未登记的槽位在挂载时抛 `宿主未登记此具名槽位`，市场页的插件详情也会把不在清单内的 `slot` 标出来。

钩子按 priority 升序、再按 ID 排序；抛错则中止后续钩子和本次提交。不要在 `transform` 中递归调用 `submit`，避免重复进入钩子链。

`context.extensions` 提供：

```text
catalog() -> {components,modules,commands,services}
executeCommand(id,input,signal) -> Promise<HostResult<JsonValue>>
callService(id,version,input,signal) -> Promise<HostResult<JsonValue>>
subscribeEvent(name,listener) -> Dispose
emitEvent(name,data) -> void
getState(key) -> JsonValue | undefined
setState(key,value) -> void
subscribeState(key,listener) -> Dispose
register?(contributions) -> Dispose
```

插件专属上下文可有 `register`，用于动态登记贡献，返回撤销函数；根宿主上下文只消费贡献。状态键和发射事件须以自己的 `<插件ID>.` 开头；跨插件数据通过公开服务交换。状态只属于当前内存注册表，卸载撤销，不能当作持久化存储。事件含 `name/data/pluginId/generation`，不能以本地状态代替服务器观测。

主题经 `context.themes.snapshot()/subscribe(listener)` 查询；`select(id)` 显式选中，`select(null)` 恢复基础主题。登记主题不自动选中。变量使用 CSS 自定义属性名，可信 CSS 的外部资源与清理由插件负责。

## 可选设备访问

`context.devices` 提供 `refreshProviders(signal)`、`refreshDirectories(signal)`、`refreshProvider(id,generation,signal)`、`snapshot()`、`select(reference或null)`、`subscribe(listener)` 与 `invoke(action,signal)`。异步刷新及调用返回 `HostResult`；`select` 是本地同步选择，不返回服务器响应。

设备引用为 `{providerId,generation,localId}`；动作形状如下：

```typescript
const action = {
  providerId: reference.providerId,
  generation: reference.generation,
  deviceId: reference.localId,
  capability: capability.id,
  version: capability.version,
  input: {},
};
```

`invoke` 返回任务。提供者能力使用 `deviceId:null`；设备能力使用当前设备 ID。先检查能力精确版本、可用状态及读写权限，不按平台名称硬编码准入。快照包含 `providers/directories/selection/selected`；设备规范状态为 `online/offline/unauthorized/unknown`，可选 `rawState` 只作观测说明。刷新或提供者换代后旧引用不可复用。目录订阅不是后台推送或常驻连接；其他实例的变化需显式刷新。

## 产物与任务历史

`context.artifacts.upload(filename, blob, signal)` 返回 `{data: Artifact,logId}`；`download(id,signal)` 返回 `{data: Blob,logId}`。产物元数据为 `id/filename/mediaType/size/sha256/createdAt`。下载得到原字节，不能当 JSON 封套拆包，也不能把产物 ID 当服务器文件路径。协议 2/3 的任务结果可能是 `{result,artifacts}`，按实际 JSON 形状检查再读取其中业务结果。

`context.taskHistory` 提供 `list({limit?},signal)`、`get(id,signal)` 与 `events(id,{after?},signal)`。前两者返回历史任务，额外含 `input/createdAt`；events 返回 `{sequence,jobId,status,timestamp}` 数组。时间为 Unix 毫秒。limit 显式值为 1..200 安全整数；省略交服务器默认 50。after 为非负安全整数，每批最多 200 条；下一批使用已成功处理的最后 sequence，允许间隙。它不是日志、百分比进度或推送订阅，也没有列表游标和平台过滤。

## 已装配的宿主服务

先从 `extensions.catalog().services` 确认 ID 和精确版本，再调用。当前产品 runtime 提供下列版本 `"1"` 服务；可用的服务器插件、项目配置和设备仍需满足业务前置条件：

| ID | 动作 |
| --- | --- |
| `host.performance` | `capabilities/start/inspect/pause/resume/stop/samples/list` |
| `host.ai-sdk` | `runtime.status/sdk.single/sdk.turn/session.get/session.close/assistant.run` |
| `host.ai-sdk.stream` | `open/resume/output/poll/definitions/records/query/cancel/clear/snapshot` |

无附加参数的读取示例是 `callService('host.performance','1',{action:'capabilities'},signal)`、`callService('host.ai-sdk','1',{action:'runtime.status'},signal)` 和 `callService('host.ai-sdk.stream','1',{action:'snapshot'},signal)`。不要添加未知字段。性能 inspect/pause/resume/stop 使用 `{action,input:{session_id}}`；samples 再含数值 after/limit，list 使用 `{action:'list',input:{limit,after_id?}}`。AI 有输入的动作使用 `{action,input}`；输入须按相应真实操作 Schema 与部署配置取得，不能从服务 ID 猜测项目、模型或令牌。

服务版本是契约选择，不能把版本 `"1"` 改成 `"^1"`。服务不存在或提供者卸载后应显示不可用，不能偷偷绕过宿主直接抓私有状态。

## 界面套件（hostUi）

宿主自带一份 React 与一套组件。插件不打包 React，改用宿主的实例，这样只有一份协调器、hooks 与 context 全部正常，样式和主题也自动跟随。

浏览器插件通过宿主提供的公共 ESM 说明符直接导入，无需访问宿主文件：

```js
import { React, mountReact, Button, EmptyState } from 'deviceforge-host';
```

宿主按说明符生成六份独立 ESM 入口，只从全局契约 `__DEVICEFORGE_HOST_UI__` 取值，均不内联第二份 React。插件构建时将这些裸模块名保留为 external，自动 JSX 运行时及常见命名导入均使用宿主实例。

| 说明符 | importmap 入口 | 常见导入 |
| --- | --- | --- |
| `deviceforge-host` | `/plugin-host.js` | `Button`、`mountReact` |
| `react` | `/plugin-react.js` | 默认 `React`、`useState`、`createContext` |
| `react-dom` | `/plugin-react-dom.js` | `createPortal`、`flushSync` |
| `react-dom/client` | `/plugin-react-dom-client.js` | `createRoot`、`hydrateRoot` |
| `react/jsx-runtime` | `/plugin-jsx-runtime.js` | `jsx`、`jsxs`、`Fragment` |
| `react/jsx-dev-runtime` | `/plugin-jsx-dev-runtime.js` | `jsxDEV`、`Fragment` |

这些公共入口由运行宿主直接提供，插件只需保留对应裸模块导入并检查目标宿主是否支持。入口缺失或命名导出不兼容时提示升级宿主，不要求插件开发者运行宿主生成器。

| 成员 | 说明 |
| --- | --- |
| `apiVersion` | 当前为 `1`；宿主没有这个契约时取不到，说明宿主太旧或页面不是宿主加载的 |
| `React` / `ReactDOMClient` / `jsx` / `jsxs` / `Fragment` | 宿主的真实实例，用于写组件与创建元素 |
| `mountReact(root, element)` | 用 `createRoot` + `flushSync` 挂载，返回释放函数；**直接把它作为 `mount` 的返回值** |
| `cn(...)` | 宿主同一套类名合并 |

组件（与 `components/index.ts` 的公开桶同名）：`Button`、`Input`、`Textarea`、`Label`、`Switch`、`Checkbox`、`Badge`、`Progress`、`Alert`＋`AlertTitle`＋`AlertDescription`、`Card` 系列、`Field`、`FormSection`、`FormRow`、`FormGrid`、`FormActions`、`PageTitle`、`EmptyState`、`ErrorNotice`、`JsonResult`、`FileDropzone`、`Stepper`、`MultiTrackChart`、`BlobDownload`、`Select` 系列、`Tabs` 系列、`Table` 系列。

三条边界：

1. **属性不做逐条校验**。契约刻意写宽（`HostComponent`），宿主的组件库升级不强制所有插件重编；写错属性不会在编译期报错，运行期由宿主组件自己决定怎么处理。
2. **`ErrorNotice` 是弹 toast，不是行内提示**。行内错误用 `Alert`。
3. **自己写的类名要带 `df-<插件ID>-*` 前缀**。宿主的 Tailwind 只扫宿主源码，不会替你生成类。

挂载示例：

```js
async mount(target, context) {
  return mountReact(target, React.createElement(MyPanel, { context }));
}
```

## 完整发布与配置边界



`release.json` 管理外层组件和工具闭包，不改变 `HostContext`。安装管理属于宿主管理界面及公开 HTTP/MCP 用例，SDK 不因此获得任意包安装、文件系统或令牌字段。安装任务必须查询终态；`enabled` 表示服务器持久启用意图，当前浏览器模块是否成功激活仍需单独确认。

服务器进程通过 `DEVICEFORGE_PLUGIN_RESOURCES` 和 Rust `apk_plugin_sdk::managed_resources()` 取得工具入口，通过 `DEVICEFORGE_PLUGIN_CONFIG` 读取有效配置；这两个字段均不进入浏览器上下文。工具默认路径只覆盖服务器有效快照，用户高级显式路径优先，配置原值与修订保留在运行宿主用户根。浏览器不得推断开发机或同事本机目录，也不能把资源描述暴露为下载接口。

浏览器配置保留自己的版本、原值及敏感路径，凭据展示走宿主管理流程，不把 `********` 当真实输入再次提交。发布 requirements 的来源候选按原值判断；浏览器保存记录的服务器启用门禁不具备服务器插件同等的 schema/版本校验，必须继续检查本地配置兼容性与实际激活错误。
