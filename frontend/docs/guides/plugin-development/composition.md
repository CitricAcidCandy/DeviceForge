# 开放扩展与独立 SDK

本主题面向独立插件工程，不要求克隆宿主或读取宿主实现。以下能力均为 SDK v2 的可选扩展；目标宿主没有相应入口时，显示明确的能力缺失原因，不改用宿主私有模块。

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

`payload` 可以承载组件、函数或对象，但它的具体形状必须由扩展点提供者公开约定，并由消费方验证。它不进入跨端目录、持久布局或 JSON 数据，不代表自动具备设备控制权。更新数据不改变贡献身份；结构或 JSON 校验失败时不覆盖旧值，符合 JSON 但不符合扩展点 Schema 的更新会保留为 `invalid` 项，不再参与渲染。

## 工作区、通信和数据

主入口同时导出 `UiAccess`、工作区布局与视图契约、`PluginTransport` 及 `DataAccess`。相应能力通过 `context.ui`、`context.transport` 和 `context.data` 取得。可选能力的存在仅证明宿主有该公开入口，不证明任意目标、视图或业务前置条件可用。

- 工作区定义页面、视图和布局；同一视图允许多个实例，实例与目标及代次独立。组件及挂载函数只存在本地，不序列化到服务器。
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

具体签名以交付包内的公开类型为准；完整的独立示例应随目标能力与当前发行物一并提供。类型包不替代宿主实际装配，也不能把模型存在说成完整界面已经可用。

## 生命周期与发行边界

定义、贡献和订阅由登记它们的作用域追踪；挂载或功能子作用域撤销时，其贡献立即失效，不延长到整个插件的寿命。旧代释放不能撤销新代同名内容，晚到结果不得写回新实例。可信插件自行创建的事件、定时器和外部资源仍须登记可释放函数。

配置、市场信息和前后端组件仍维护在单一 `manifest.json`。SDK TGZ 是开发依赖，不替代插件发布包。继续使用已交付 CLI 的公开打包流程；不使用未发布的 registry 地址，不要求插件开发者执行宿主构建或内部维护检查。
