# 开放扩展与独立 SDK

本主题面向独立插件工程，不要求克隆宿主或读取宿主实现。以下能力均为 SDK v2 的可选扩展；目标宿主没有相应入口时，显示明确的能力缺失原因，不改用宿主私有模块。

## 组合能力由插件使用

组合能力是供插件在激活、目标出现和依赖恢复时自动贡献界面，不是要求最终用户搭建工作台。普通产品界面不以“添加功能”、编辑布局或拖拽作为功能启用前提；页面与功能的正常业务操作仍由各插件提供。

登记视图只使它进入目录，不保证它已出现在某个业务页面。要加入已有区域，使用该区域提供者公开的扩展点，并遵守其消费契约；不要要求用户手动打开目录补装配，也不要读取宿主私有 DOM。仅更换整页或整个外壳时，继续遵守明确选择、必要确认及恢复策略，不按装载顺序抢占。

设备与文件官方页面分别公开 `deviceforge_devices.tools@1`、`deviceforge_files.tools@1`，均接受追加数据 `{title,pluginId,viewId}`。先登记自有视图，再在激活时声明贡献，消费方会自动组合和撤销，不要求用户搭建：

```typescript
const points = context.extensions?.points;
if (!points || !context.ui) throw new Error('当前宿主没有公开页面组合能力');
// sample.panel 必须已通过 ui.register 登记，挂载函数遵循同一公开生命周期。
for (const pointId of ['deviceforge_devices.tools', 'deviceforge_files.tools']) {
  points.contribute({
    id: `sample.auto.${pointId}`, point: { id: pointId, version: '1' }, mode: 'append',
    data: { title: '插件工具', pluginId: 'sample', viewId: 'sample.panel' },
  });
}
```

这是上述页面插件自行定义的公开契约，不是宿主固定槽位枚举。目标页面未加载时贡献等待，出现后由页面消费方建立有归属的临时视图实例；贡献卸载时消费方仍存活，能够撤回自有区域、保留其他内容。不能在自己的上下文撤销后继续写页面布局善后，也不能把加载视图视为开始采集或派发设备写入。其他页面插件可以自行定义其扩展点与消费规则。

## 页面任务归属与原位元数据更新

页面提供者在 `ui.register({ pages: [...] })` 中用 `operations` 声明精确操作标识，或显式以 `taskPolicy: 'all'` 声明全部任务；省略策略按操作列表匹配，不按命名空间前缀猜测。任务插件读取公开页面目录，默认外壳使用公开哈希地址定位页面；地址缺失或冲突时显示范围未确认，不退回全部任务。最近记录有数量上限，匹配数量不代表全部历史。

提供者目录变化时，支持 `ui.updatePage` 的宿主可在原位更新元数据，不先撤销页面，也不让现有实例换代或丢失草稿：

```typescript
const ui = context.ui;
if (!ui?.updatePage) throw new Error('当前宿主没有页面元数据原位更新能力');
ui.register({ pages: [{
  id: 'sample.page', title: '示例', route: '/sample', workspaceId: 'sample.workspace',
  operations: ['sample.read'], taskPolicy: 'listed',
}] });
ui.updatePage('sample.page', { operations: ['sample.read', 'sample.write'] });
```

更新仅允许 `title/navigation/operations/taskPolicy`，并继续校验、复制和冻结公开目录。不能更改路由、工作区或挂载函数；只能更新当前所属作用域登记的页面，旧代或已经撤销的作用域不能覆盖新登记。原登记的释放句柄仍撤销更新后的页面。旧 SDK v2 宿主可以不提供此能力，插件须检查；缺省不代表动态声明已生效。

`updatePage` 和扩展点只读 `selection` 已包含在本批重新生成的本地SDK归档声明中；同为0.1.0的早期归档和运行中指南不能据此视为已更新，须以实际取得的SDK类型、字节摘要和宿主能力为准。宿主不支持时按可选能力处理，不调用私有接口兜底。

## 取得 SDK

已提供 `@deviceforge/plugin-sdk@0.1.0` 的本地 TGZ，尚未发布 npm registry。开发者取得实际文件 `deviceforge-plugin-sdk-0.1.0.tgz` 后，可在自己的工程运行 `npm install --save-dev ./deviceforge-plugin-sdk-0.1.0.tgz`。包内已包含 ESM 与类型声明，不需要任何宿主生成器。UI 完整类型所需的 React、Radix 和 clsx 类型配套依赖在包的 `peerDependencies` 中明确列出，离线开发时一并预备。

```typescript
import type { HostContext, WebPlugin, PointRef } from '@deviceforge/plugin-sdk';
import { isJsonValue } from '@deviceforge/plugin-sdk/json';
```

SDK 只交付契约、错误类型、标识辅助、JSON 守卫及读取现有宿主 UI 的函数，不带第二套 React、任务执行器或插件管理器。浏览器插件构建时将 React、ReactDOM、JSX 运行时和 `deviceforge-host` 保持为 external，使用宿主提供的同一实例。

## 插件自行定义扩展点

先检查 `context.extensions?.points`。提供者定义自己命名空间下的扩展点，消费者仅按公开 ID 和精确版本登记贡献；消费者无需导入提供者代码，也不用向宿主申请增加槽位枚举。

```typescript
const ref: PointRef = { id: 'sample.tools', version: '1' };

export default {
  id: 'sample', version: '1.0.0', apiVersion: 2, panels: [],
  async activate(context: HostContext) {
    const points = context.extensions?.points;
    if (!points) throw new Error('当前宿主未提供开放扩展点');
    points.define({
      ...ref, title: '插件工具', modes: ['append', 'replace'],
      inputSchema: {
        type: 'object', properties: { title: { type: 'string' } },
        required: ['title'], additionalProperties: false,
      },
    });
  },
} satisfies WebPlugin;
```

另一个插件可以在目标出现之前登记：

```typescript
const points = context.extensions?.points;
if (!points) throw new Error('当前宿主未提供开放扩展点');
const handle = points.contribute({
  id: 'consumer.inspect', point: { id: 'sample.tools', version: '1' },
  order: 10, mode: 'append', data: { title: '检查结果' },
});
handle.update({
  id: 'consumer.inspect', point: { id: 'sample.tools', version: '1' },
  order: 10, data: { title: '查看检查结果' },
});
```

贡献状态为 `waiting/version_mismatch/invalid/active`；扩展点尚未存在时等待，精确版本不匹配不激活，数据按扩展点 Schema 校验。`catalog()` 只提供可序列化元数据，`list(ref)` 还保留本地 `payload`，供该扩展点的渲染器消费。渲染器只渲染 `active` 项；追加项按顺序与稳定 ID 排列，替换项必须显式 `select(ref,id)`，不能按装载顺序抢占。

可选 `selection(ref)` 只读返回已选择的贡献标识，即使提供者暂时不可用；`selected(ref)` 仍只返回当前可用的选择。因此，卸载或依赖撤销不能冒充用户执行了 `select(ref,null)`，也不能把暂缺状态持久保存为用户清空。原已选的同一贡献恢复时可以重新挂载，但未选过的新贡献不得自动接管，业务写入也不得重放。旧宿主可能缺少 `selection`，调用前先判断能力；当前开发源码已提供，本地SDK发行包是否包含该可选声明须按实际发行物核对，不能拿旧包版本号推断。

`payload` 可以承载组件、函数或对象，但它的具体形状必须由扩展点提供者公开约定，并由消费方验证。它不进入跨端目录、持久布局或 JSON 数据，不代表自动具备设备控制权。更新数据不改变贡献身份；结构或 JSON 校验失败时不覆盖旧值，符合 JSON 但不符合扩展点 Schema 的更新会保留为 `invalid` 项，不再参与渲染。

## 工作区、通信和数据

主入口同时导出 `UiAccess`、工作区布局与视图契约、`PluginTransport` 及 `DataAccess`。相应能力通过 `context.ui`、`context.transport` 和 `context.data` 取得。可选能力的存在仅证明宿主有该公开入口，不证明任意目标、视图或业务前置条件可用。

- 工作区定义页面、视图和布局；同一视图允许多个实例，实例与目标及代次独立。组件及挂载函数只存在本地，不序列化到服务器。同一提供者重复页面路径会被拒绝；不同提供者声明同一路径时，目录保留来源，默认外壳显示冲突而不按加载顺序抢占。撤销冲突来源后恢复可用目录，已有草稿不因此清空。
- 通信复用当前宿主连接和取消信号，不暴露令牌；跨端是异步操作，提交完成不等于业务成功。需要取消后端任务时显式取消并查询最终状态。
- 数据源通过已有精确版本服务读写，使用修订值判断冲突。冲突保留草稿，结果未知先重新读取，不自动重放写操作。`persistence` 为可选的 `memory` 或 `persistent`：前者只声明内存保存，后者声明提供者负责持久保存；省略表示未声明，消费方不得猜测“仅内存”或“已持久保存”。`applyPolicy` 的立即生效或待重载与保存方式是两种独立属性。

提供渲染能力的宿主还可提供 `context.ui.mount(instanceId,target,signal): Promise<Dispose>`，供独立外壳或布局插件挂载已经选定提供者的视图实例。纯模型装配可以不提供此方法，调用前须同时检查 `ui` 和 `ui.mount`：

```typescript
const ui = context.ui;
if (!ui?.mount) throw new Error('当前宿主只提供工作区模型，尚未装配视图渲染能力');
const release = await ui.mount(instanceId, target, signal);
context.onDispose(release);
```

返回句柄只属于本次挂载；调用方中止、提供者撤销或目标换代时按现有挂载管线回收，旧释放句柄不能撤销后来新代的视图。挂载使用当前公开上下文，不泄露宿主私有装配对象。保存或恢复布局只恢复描述，挂载本身不授权重放业务写入；视图的主动业务动作仍由其公开操作与实际交互决定。

视图可以在提供者的激活函数中先登记。当前宿主会在本次挂载的固定期限内等待该提供者完成激活和配置，再调用视图的挂载函数；不要求消费者调用重试或监听外壳专有事件。等待只属于本次调用，取消、提供者撤销或实例换代会结束等待，之后的独立调用仍可执行；期限到期不会在提供者稍后就绪时偷偷补挂，也不会重放业务动作。提供者应在激活阶段登记视图，不要在同一次激活中等待自己视图的挂载，否则会形成相互等待并最终超时。

这是宿主的挂载行为修复，仍使用 SDK v2 原有签名；兼容的类型包不能证明旧宿主已经具备这项修复。升级类型包不等同于升级宿主，部署时应同时确认所用宿主版本。

具体签名以交付包内的公开类型为准；完整的独立示例应随目标能力与当前发行物一并提供。类型包不替代宿主实际装配，也不能把模型存在说成完整界面已经可用。

## 外壳与外壳自己的扩展点

支持组合根的宿主公开 `host.shell@1`，只接受 `replace`，贡献数据为 `{ pluginId: string, viewId: string }`，不再嵌套 `view` 字段。`viewId` 指向已由对应插件登记的完整视图；替换须由用户选择，不能在激活时自行抢占。新外壳准备成功后才交接，失败保留旧外壳；停用或卸载后独立恢复入口仍可用。

下面的片段放入 ID 为 `sample` 的插件激活函数中，只演示自有外壳的登记；它不提供设备或其他业务：

```javascript
const ui = context.ui, points = context.extensions?.points;
if (!ui?.mount || !points) throw new Error('当前宿主没有外壳组合能力');
ui.register({ views: [{
  id: 'sample.shell_view', title: '示例外壳', provides: ['host.shell'],
  async mount(target) {
    const root = document.createElement('section');
    root.textContent = '示例外壳；业务可通过公开工作区目录另行组合。';
    target.append(root);
    return () => root.remove();
  },
}] });
points.contribute({
  id: 'sample.shell', point: { id: 'host.shell', version: '1' }, mode: 'replace',
  data: { pluginId: 'sample', viewId: 'sample.shell_view' },
});
```

默认外壳插件 `deviceforge_shell` 自己定义 `deviceforge_shell.header@1`、`deviceforge_shell.sidebar@1` 和 `deviceforge_shell.footer@1`，目前只追加；数据同样是 `{ pluginId, viewId }`。先登记自己的完整视图，再向所需点贡献引用。它们不是宿主固定槽位枚举；其他外壳可以定义不同的点，开发者应先发现目标。点缺失则等待，贡献有效也不表示它正被当前选中的外壳显示。自定义工作区和布局同理，由其提供者公开消费契约。

设备工作区提供 `deviceforge_devices.tools@1`，只追加，数据为 `{ pluginId, viewId, title }`。登记完整视图后贡献到该点；支持此消费版本的设备插件会自动建立实例、继承当前完整设备引用并加入页面，用户不需要点击添加。贡献撤销时只关闭本消费者为该贡献创建的实例，移除相应布局节点并保留其他功能；同代更新不重复创建实例，新代恢复建立新的运行身份。目标页面尚未显示时只登记界面描述，不能据此重放设备操作或业务写入。其他业务页面是否具备自动消费入口，需要发现其实际扩展点，不能由该设备能力推断。

插件界面应按挂载容器而非浏览器窗口宽度响应。使用 Tailwind CSS 容器查询或等效的公开布局能力；宽浏览器中的窄浮窗不能仍强制采用桌面多列。完整发布包自行携带生成后的样式，宿主不会为未见过的第三方源码生成 Tailwind 类。

`custom` 布局的 `children` 是交给布局提供者解释的描述。默认外壳在窄容器中仍挂载该提供者，不把子项直接顶替成通用页签，也不接管其内部子实例的可见性；提供者负责内部响应式、子实例展示与资源管理。外壳收缩导航或容器变化不应重建已完成挂载的草稿。

调用公开共享UI的 `mountReact` 时，首次渲染及首次布局提交的未捕获错误会作为挂载失败返回；不得将函数内部没有同步抛错的React提交误判为成功。已经返回的释放函数仍按原归属幂等回收。提供者就绪通知不得打断正常在途挂载，业务异常和未知结果不随通知自动重放；需要重新打开时由显式操作决定。

## 只读界面与管理目录

支持本组合版本的宿主可以提供以下精确版本服务。调用前用 `context.services.catalog()` 确认实际可用性；旧运行宿主不会因文档更新而自动获得这些能力。

| 服务与输入 | 结果与边界 |
| --- | --- |
| `host.ui-directory@1`，`{action:'snapshot'}` | 返回 `snapshotVersion:1`、修订号、`slots/points/ui` 三组公开目录；不返回 DOM、函数、实例目标、布局或贡献的业务数据 |
| `host.browser-plugins@1`，`{action:'snapshot'}` | 读取浏览器运行、包与完整安装来源、随附状态和清理诊断；不联网，目录的 `known:false` 不能当作空目录 |
| `host.browser-plugins@1`，`{action:'refresh'}` | 通过既有控制器显式刷新包及完整安装目录；复用在途读取，不重放管理操作 |

界面目录的 `slots` 为 `{known,entries:[{id,modes,ready}]}`，仅反映实际登记的挂载点，包括正在准备的晚注册槽位；页面未挂载时没有相应条目，不据此判成“非法槽位”。`points` 包含 `known/definitions/contributions`，贡献保留状态和来源但不含 `data/payload`。`ui` 包含 `known/catalog/instances`，实例不含 `target`。事件 `host.ui-directory.changed` 只通知修订变化，收到后显式重读目录，不能把事件当成完整快照。

浏览器管理事件为 `host.browser-plugins.changed`。启停随附或独立包分别使用 `{action:'setEnabled',source:'bundled'或'package',id,enabled}`，完整安装所属组件不能拆开管理。完整安装使用 `{action:'installation',operation:'enable'或'disable'或'remove'或'retryBrowser',id,revision}`；修订必须来自当前完整安装目录。配置读取为 `{action:'configuration',operation:'get',id}`，保存为 `{action:'configuration',operation:'save',id,revision,values}`；`reset/apply` 同样要求原配置修订。回执中的 `{completed:true,result}` 只表示本次控制器调用已返回，不代替目录、安装 Job 和实际浏览器激活状态。

包上传、更新及完整发布安装仍需遵循已有格式、预览、身份和修订校验。不要把原始二进制塞入服务 JSON，也不要绕过管理器仅覆盖服务器文件。配置冲突保留草稿；取消、断线或未知结果先读取实际状态，不自动重放。

## 生命周期与发行边界

定义、贡献和订阅由登记它们的作用域追踪；挂载或功能子作用域撤销时，其贡献立即失效，不延长到整个插件的寿命。旧代释放不能撤销新代同名内容，晚到结果不得写回新实例。可信插件自行创建的事件、定时器和外部资源仍须登记可释放函数。

### 已归属远程资源的清理

可选 `context.onCleanup(callback)` 将释放回调登记到当前激活、挂载或功能作用域，返回幂等 `Dispose`。普通 `context.signal` 和 `context.transport` 撤销后仍不可用；回调获得独立的 `CleanupContext.signal`、绝对截止时间 `deadline` 及可选的 `transport.request`，复用当前连接、日志和发布修订。默认整次清理受宿主 5 秒预算约束，不是每个回调另排 5 秒。

回调返回或期限到达后，清理信号和请求句柄均失效。该入口只释放已经明确归属的资源，不用于创建新会话、普通数据写入或长期订阅。手动释放与卸载共用一次回调；失败或未知不自动重放。必须按能力提供者契约核对实际释放终态，不能把请求成功当成服务器资源已回收。旧宿主缺少此可选接口时，对应远程资源功能应说明缺失，不偷偷改用卸载后的裸请求。

以下是 SDK 登记函数示意；释放地址与确认逻辑由具体能力提供者公开约定，本例不声明新业务端点，也不创建会话：

```typescript
import type { CleanupContext, Dispose, HostContext, HostResult, JsonValue } from '@deviceforge/plugin-sdk';

export function trackOwnedRemote(
  context: HostContext,
  releasePath: string,
  confirm: (receipt: HostResult<JsonValue>, cleanup: CleanupContext) => Promise<void>,
): Dispose {
  if (!context.onCleanup) throw new Error('当前宿主不支持远程资源的有界清理');
  return context.onCleanup(async (cleanup) => {
    if (!cleanup.transport) throw new Error('当前清理窗口没有公开请求能力');
    const receipt = await cleanup.transport.request({ path: releasePath, method: 'POST' }, cleanup.signal);
    await confirm(receipt, cleanup);
  });
}
```

只登记已经知道身份、并由本实例拥有的资源；不能批量停止别的会话来掩盖身份未知。创建请求结果未知时保留原日志与查询入口，不自动重新创建；清理回调本身也不能证明一个未知创建已经回滚。

配置、市场信息和前后端组件仍维护在单一 `manifest.json`。SDK TGZ 是开发依赖，不替代插件发布包。继续使用已交付 CLI 的公开打包流程；不使用未发布的 registry 地址，不要求插件开发者执行宿主构建或内部维护检查。
