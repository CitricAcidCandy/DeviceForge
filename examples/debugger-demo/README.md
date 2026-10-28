# 无需宿主源码的独立 Debugger 示例

## 数据源与Agent步骤示例

浏览器插件激活时可选登记 `demo.settings` 数据源，业务值为 `{name:'调试示例',count:0}`。数据只在当前插件激活周期内保存，不修改回显面板。完整原生ESM实现随浏览器包一起交付，不需要SDK运行时依赖。缺少 `context.debug.registerDataSource` 的旧宿主仍可正常回显，但不提供数据读写。

在兼容本机宿主明确选择这个浏览器插件并打开会话后，先调用 `deviceforge.debug_data_catalog({session_id,parameters:{}})`，再用 `deviceforge.debug_data_read({session_id,parameters:{source_id:'demo.settings'}})` 取得当前不透明修订。写入使用读取到的真实 `revision`，完整值例如 `{name:'新名称',count:2}`，并带 `confirmed:true`。宿主映射的公开修订不能硬编码为示例内部的数字修订。

也可将以下 `parameters` 交给 `deviceforge.debug_automation_run`；外层另带实际 `session_id`：

```json
{"confirmed":true,"steps":[
  {"id":"读取","tool":"data_read","parameters":{"source_id":"demo.settings"}},
  {"id":"保存","tool":"data_write","bind":{"revision_from_step":"读取"},"parameters":{"source_id":"demo.settings","value":{"name":"新名称","count":2},"confirmed":true}},
  {"id":"回读","tool":"data_read","parameters":{"source_id":"demo.settings"}}
]}
```

写回回调在同一不让出执行权的片段中比较实际修订与修改；真实异步存储应使用事务或等价原子比较。超时不能强制停止可信插件代码，回调必须在实际提交时检查修订和取消。写入回执未知时不重新发送，可用 `deviceforge.debug_command({session_id,command_id})` 查询已保留回执，再读取实际数据。报告中的保存和回读是证据，不能替代业务相等断言或真实设备验收。

将本目录作为自己的独立工程保存即可开发、测试和打包。需要 Node.js 22.18 及以上和 npm；没有 npm 依赖，无需执行安装依赖命令。浏览器采用原生 ESM、公开 SDK v2 对象接口，服务器采用无 SDK 的 Node JSON 协议 1。没有宿主类型路径、虚构的 npm 包或内部脚本依赖。

运行环境由使用者提供：兼容 DeviceForge 发行版及其 localhost 宿主网页和 MCP 服务地址，例如部署者实际配置的 `http://127.0.0.1:<端口>`。本工程不附带、不构建、不启动宿主，也不连接设备。实际发行版缺少能力时应明确升级，不从源码猜接口。

## 文件职责与打包

| 目录 | 内容 |
| --- | --- |
| `browser/` | 完整浏览器包、公开贡献、可选调试登记与公共调试服务消费辅助函数 |
| `server/` | 完整服务器包、协议读取器和纯回显处理器 |
| `tools/` | 自有 ZIP 打包器，生成组件包和完整离线发布 |
| `tests/` | 公开接口替身、真实 Node 协议进程、归档闭包和独立目录验证 |

在本目录执行：

```powershell
npm test
npm run pack
```

打包生成 `dist/browser.zip`、`dist/server.zip`、完整离线包 `dist/debugger-demo.zip` 和 `dist/checksums.json`。摘要及长度取最终字节；打包器不会覆盖同名文件，再次打包可执行 `node tools/pack.mjs ./dist-next` 选择新目录。两个组件也可分别进入自己的目录执行 `npm pack --ignore-scripts`，不依赖本工程打包工具。

完整离线包使用公开 `format_version=1,host_api_version=2` 兼容格式，根直接含 `release.json` 和真实组件 blobs；没有外部工具或依赖下载。Node 运行时须由部署者准备。安装完整包后按完整发布管理，不拆装其所属组件；单组件归档只供独立组件流程。可接受的发布格式以实际宿主能力为准。

## 安装后使用

1. 在部署者提供的宿主原市场本地导入入口选择完整离线包，按原安装流程启用。也可使用该发行版公开 MCP 安装流程；本例不发市场、不另建调试安装入口。
2. 从公开目录确认服务器 `demo_debugger_server@1.0.0`、浏览器 `demo.debugger.browser@1.0.0`，以及操作 `plugin.demo_debugger_server.echo`。安装成功不等于已加载或浏览器已经挂载。
3. 浏览器包提供面板、`developer.tools` 追加组件、自有 `/echo` 模块和该模块页面的 replace 组件。自有页面槽位是 `page.demo.debugger.browser.echo`，由宿主选择当前贡献；不会替换设备区域。所有挂载共用同一实现，每个实例各自登记和释放资源。无样式语义 HTML 仅用于接口演示，不是产品界面设计交付。
4. 点击“提交服务器回显”只提交一次已知纯回显任务，并轮询同一个 Job。结果保留提交和查询的日志 ID。重复点击、关闭、取消或失败均不会自动重放提交；卸载只取消本地等待，不隐式取消服务器任务。必要时使用原 Job 入口显式取消。
5. 可选 `context.debug` 主动登记状态语义节点、事件和监听资源；缺少该能力时回显和正常释放仍可用。资源还通过公开 `context.onDispose` 管理。元数据不放消息正文或凭据，不启动心跳与额外调试进程。

## 从自有工具消费公共 Debugger

公共浏览器入口为 `context.extensions.callService('host.debugger', '1', request, signal)`，返回原 `HostResult` 的 `data/logId`。`browser/src/debugger-client.js` 提供不依赖宿主的调用辅助函数。以下代码在自己的插件已经取得 `context` 和 `callerSignal` 后运行：

```javascript
import { debuggerRequest, debuggerTool, confirmedResponse, snapshotPage } from './debugger-client.js';
const signal = AbortSignal.any([context.signal, callerSignal]);
const status = await debuggerRequest(context, { action: 'status' }, signal);
// 以下为按需显式调用的不同步骤，不自动连续执行。
const started = await debuggerRequest(context, { action: 'start' }, signal);
const targets = await debuggerTool(context, 'deviceforge.debug_targets', {}, signal);
```

| action | 参数及意义 |
| --- | --- |
| `capabilities` / `status` | 实际桥状态、能力及 `production_acceptance_complete=false` |
| `start` | 显式启动当前浏览器桥 |
| `reconnect` | `input:{confirmed:true}`；结束旧实例会话，不重放动作 |
| `call` | `name` 为公开 `deviceforge.debug_*` 工具，`input` 为该工具参数 |
| `installation` | 当前安装构建信息；缺接线时返回明确不可用 |
| `logs` | `input:{log_id?,q?,order?}` 简单搜索；不接收诊断流分页游标 |
| `focus` | `input` 指定 `target_kind/plugin_id` 或明确 `candidates`；要求已启用官方面板 |

从真实 `browser_targets` 明确选择当前插件、实例和代次得到 `target`，再调用：

```javascript
const opened = await debuggerTool(context, 'deviceforge.debug_session', { action: 'open', target }, signal);
const sessionId = opened.data.session_id;
const inspected = confirmedResponse(await debuggerTool(context, 'deviceforge.debug_inspect',
  { session_id: sessionId, parameters: {} }, signal));
```

`target` 必须由使用者根据真实目录明确选择，不能默认取第一个实例。后续用 `inspect` 返回的实际挂载根 ID；普通 DOM 可观察不代表它是公开扩展点。浏览器工具可能返回命令回执，须确认 `state=succeeded` 再使用 `response`；未确认回执不自动重发。

浏览器服务试调用使用：

```javascript
const invocation = await debuggerTool(context, 'deviceforge.debug_invoke', {
  session_id: sessionId,
  parameters: { kind: 'service', id: 'demo.debugger.browser.echo', version: '1',
    input: { message: '你好' }, confirmed: true, allow_unknown_side_effects: true,
    include_result: true },
}, signal);
```

`include_result` 只适用于浏览器，缺省为 `false`，不复制或遍历完整返回载荷。服务器普通操作／服务返回原 `job_id/operation/status`，不接受该字段；服务器示例选择 `kind:'operation',id:'plugin.demo_debugger_server.echo'`，不要传服务版本。

## 日志、报告与换代

`deviceforge.debug_events` 的 `source:'logs'` 查询必须指定 `plugin_id`，可带 `generation/log_id/job_id/session_id/q/order/cursor/limit`；`limit` 为 1–100。服务器真实持久日志查询先筛选排序再分页，返回 `entries/next_cursor/limited/coverage`。游标是不透明值，续页保持原筛选；过期或改变条件从首页重查。当前集成源码已有 HTTP/MCP 适配器注入；这里没有真实宿主联调证据。缺端口时明确报 `debugger_diagnostics_unavailable`，不能用最近生命周期事件伪造服务器日志。

`source:'lifecycle'` 保留 `session_id/after/limit` 有界事件，省略 `source` 的旧调用仍兼容；生命周期 `after` 不能当作持久日志 `cursor`。

```javascript
const exported = await debuggerTool(context, 'deviceforge.debug_report', {
  session_id: sessionId, parameters: { export: 'json' },
}, signal);
const { report, artifact } = exported.data;
```

`parameters.export` 可为 `none/json/markdown`，默认 `none`；返回 `{report,artifact}`，不导出时 `artifact=null`，导出时含产物元数据和下载 URL。按实际 URL 获取字节并核对，不能把报告生成等同于产物下载通过；缺产物存储或导出未确认时不自动重试。字段递归脱敏不能识别自由文本中的所有秘密。

报告内 `evidence.continuation` 或 `snapshot_manifest` 指向的冻结快照通过 `snapshotPage(context,sessionId,continuation,signal)` 续读，即 `deviceforge.debug_ui_tree` 的 `root_id/snapshot_id/offset/limit`；根据 `tree.page.nextOffset` 继续同一快照。不要把这些参数传给 `debug_report`，不要在翻页时重采变化中的 DOM。快照过期时明确重新采集，不假定缺页证明节点不存在。

重载后旧会话进入 `target_changed`。重新查询目录，核对真实新代次后显式调用 `debug_session` 的 `action:'select',session_id,target`，或打开新会话；未确认、超时和断线都不能自动重放旧动作。完成后用 `action:'close'` 只关闭自己的会话。

## 本次验证边界

2026-10-28，Node v24.14.0，四个指定测试文件共 21 项通过。测试覆盖公开贡献与缺少可选 debug、多个挂载清理、登记失败回滚、旧结果隔离、Job 轮询和不重放、公开调试服务及快照续页、协议校验、真实 Node stdin/stdout、ZIP CRC／目录／闭包，以及复制到独立目录后导入和实际打包。真实 Node 子进程均已退出，临时归档和目录已回收。

归档字节在单元测试内生成核对，固定 `dist` 发布文件由上述打包命令生成。本轮未启动宿主、未上传安装、未执行浏览器或设备验收、未验证官方面板与本例真实闭环、未执行 Cargo／全仓／完整构建或正式分发。`production_acceptance_complete=false` 保持不变。集成后的实际宿主和包身份、运行结果及剩余缺口由集成方另行记录。
