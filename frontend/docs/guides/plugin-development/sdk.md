# 浏览器公开 SDK v2

可选 `context.services` 提供精确引用调用、类型化调用、功能级依赖和诊断；`services.server.list/submit` 访问服务器目录与共享 Job，任务继续使用 `getJob/cancelJob`。组合示例、契约校验、父子期限、代际与清理边界见[插件生命周期与功能级服务组合](../../implementation/插件生命周期与功能级服务组合.md)。

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
  listOperations(signal: AbortSignal): Promise<HostResult<readonly Operation[]>>;
  submit(operation: string, input: JsonValue, signal: AbortSignal): Promise<HostResult<Job>>;
  getJob(id: string, signal: AbortSignal): Promise<HostResult<Job>>;
  cancelJob(id: string, signal: AbortSignal): Promise<HostResult<Job>>;
  subscribeOperations(listener: (items: readonly Operation[]) => void): Dispose;
  onDispose(dispose: Dispose): Dispose;
}
```

`HostContext` 另有可选 `extensions/devices/artifacts/taskHistory/themes`，旧宿主或独立装配可省略，必须先判断。SDK 通常采用 camelCase，`Operation.input_schema` 则保留该公开字段名；不要自行将 SDK 参数变成 HTTP snake_case。`execution` 只描述当前操作总预算，不允许浏览器覆盖预算，也不用于给历史任务补写元数据。

## 扩展贡献

所有界面 `mount(target, context)` 返回 `Promise<Dispose>`。使用本次挂载收到的上下文，退出挂载时即可撤销子作用域。`panels` 项为 `{id,title,mount}`；可选 `contributions` 的字段如下：

| 字段 | 结构或签名 |
| --- | --- |
| `components` | `{id,title,slot,mode?: 'append'或'replace',mount}` |
| `modules` | `{id,title,route,mount}`，`route` 为宿主路径（`/catalog`），派生出插件页面与侧栏「插件」分组条目 |
| `commands` | `{id,title,execute(input,context,signal): Promise<HostResult<JsonValue>>}` |
| `services` | `{id,version,invoke(input,context,signal): Promise<HostResult<JsonValue>>}` |
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

接管是**热拔插**的：插件装载即接管、卸载即回落，页面代码不需要知道插件存在。接管期间槽位顶部有一条 28px 来源条（插件标题 + 等宽插件 ID +「恢复默认」）；「恢复默认」只写本地忽略表并回落到宿主内容，不卸载插件、不改配置。挂载失败时换成琥珀降级条，宿主内容照常显示。

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

入口在 `plugin-sdk/ui.ts` 的 `hostUi()`；在浏览器里更常用的是宿主垫片：

```js
import { React, mountReact, Button, EmptyState } from 'deviceforge-host';
```

`deviceforge-host` 由宿主的 importmap 指到 `/plugin-host.js`，它只从全局契约 `__DEVICEFORGE_HOST_UI__` 取值，自身不带 React。`react`、`react/jsx-runtime`、`react-dom/client` 三个说明符同样指向它，所以插件用自动 JSX 运行时也不需要打包 React。

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
