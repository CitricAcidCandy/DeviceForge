# 插件调试器非界面观测底座

本模块只实现可审计的主动登记和公开 DOM 观测，不包含 TSX、产品页面、源码断点、任意 JavaScript 执行或 React Fiber 读取。宿主装配通过本目录 `index.ts` 消费；公开插件只使用 SDK 中的可选 `context.debug`。

## 公开入口

```typescript
createDebugRegistry(owner, signal, track);
scopedDebugAccess(parent, signal, track);
createUiCollector(root, { owner, surfaces, hostOverview, semantic });
queryTree(snapshot, query);
diffTrees(before, after);
assertTree(snapshot, assertion);
createDebugActions(collector, { signal, allowedRoutes, navigate });
```

- `DebugOwner` 为 `{ pluginId, generation, instanceId? }`，插件代次是非负安全整数。
- registry 返回 `{ debug, snapshot, dispose }`；`debug` 供宿主注入上下文，`snapshot` 供本机桥消费。
- `context.debug.registerNode({ id, parentId?, role, label, metadata? })` 返回 `{ id, generation, update, dispose }`。节点标识在当前父 registry 内唯一，子作用域应采用自己的业务前缀。
- `context.debug.emit({ name, nodeId?, metadata? })` 只登记结构化事件，不截获控制台或请求体。
- `context.debug.registerResource({ id, kind, label, metadata? }, release)` 返回幂等释放函数。资源释放是回调完成证据，不证明操作系统资源已退出。
- `scopedDebugAccess` 只撤销本子作用域登记；传入空父入口时返回 `undefined`，不构造虚假可用能力。

## 模块职责

| 模块 | 职责 | 不负责 |
| --- | --- | --- |
| `registry.ts`、`scoped.ts` | 主动登记、事件、资源归属、代际与子作用域清理 | runtime、manager、scope 装配 |
| `collector.ts`、`dom-evidence.ts`、`layout.ts` | 精确 DOM 根观测、公开标签、布局矩形和裁切、稳定引用与冻结分页 | React 内部结构、组件 props、遮挡推断 |
| `query.ts`、`diff.ts`、`assert.ts` | 快照纯查询、差异、三态断言 | DOM 副作用、业务成功推断 |
| `actions.ts`、`form-actions.ts`、`pick.ts` | 确认、受控 DOM 事件、原生约束、取消与一次拾取 | 设备指令、表单提交、任意脚本 |
| `contracts.ts` | 可 JSON 序列化的桥接契约 | DOM 引用、函数、传输协议装配 |
| `action-types.ts`、collector 本地接口 | DOM 和回调注入契约 | 对外 JSON 传输 |
| `json.ts`、`privacy.ts` | 元数据复制、敏感键拒绝和已知字符串脱敏、容量与只读快照 | 任意对象路径查询、日志持久化 |

## 所有权和证据

`createUiCollector` 必须给出精确 `owner`，根 DOM 由宿主定位注入。读取 `data-deviceforge-plugin`（兼容 `data-deviceforge-plugin-id`）与 `data-deviceforge-generation` 核对边界；父链有其他插件或代次时不采集。注入的 `surfaces` 每项含 `{ id, kind, element, owner }`，`kind` 只能为 `surface/slot/panel`；普通 DOM 上的 slot、panel 或 extension 属性不自动升级成真实扩展点。

`hostOverview` 默认关闭。开启时也只对已注入的其他插件扩展点生成无名称、无元数据的不透明浅层记录，不读取其后代、语义回调或引用标签。可选 `semantic(element)` 只用于宿主主动补充的语义，不开放对象路径。

节点 `id` 绑定当前观测器的实际 Element，而非 DOM 顺序。无关兄弟刷新不改变目标节点引用；节点公开证据变化才增加 `revision`，角色、控件类型、显式代次或语义 generation 变化会增加节点 `generation`。替换 Element 会取得新 id。动作在执行前重新观测并核对完整 `{ id, generation, revision }`，拒绝旧引用。不同 collector 或 owner 的快照不能比较。

展示页最多 500 节点、UTF-8 JSON 最多 1MiB，本机历史最多十个逻辑快照，扫描队列和访问最多 5000 元素，逻辑采集预算仍为 1MiB。`snapshot()` 返回第一页，`page(id,offset,limit)` 和 `pages(id)` 读取同一冻结采集，不重采、不占新历史。保留字节、扫描和展示页限制原因，`page.total` 只含实际已采节点。字节数包含 `bytes` 字段；查询、断言和动作通过 collector 的有界内部证据跨展示页消费，不能把第一页以外视为不存在。

不采集 input/textarea 值、密码内容、选择值、可编辑内容、props、私有属性或任意路径。可访问名称是有界的公开标签近似，不是完整浏览器无障碍树算法。canvas、iframe、对象、可编辑区域、可见 shadow root 和显式不透明根不深入。关闭的 shadow root、虚拟列表未挂载内容、组件来源和状态均未知。

`hidden` 仅表示 CSS/HTML 是否声明隐藏；`hidden: no` 不证明真实可见。`layout` 分开记录客户端矩形、视口、挂载区域和轴向裁切交集，缺少布局引擎或复杂裁切时为未知。独立 `visible` 仅在明确隐藏或可靠零尺寸时为 `no`，其余为 `unknown`；`occluded` 始终未知，不把几何测量当作像素可见或视觉通过。`invalid` 无显式 ARIA 证据时保持 `unknown`。

查询限于精确 id、角色、名称、扩展点和公开状态，不接受任意 CSS、XPath 或 JavaScript。断言返回 `passed/failed/indeterminate`。无截断、不透明或排除边界时，数量和缺席结论也仅针对当前已挂载 DOM，不涵盖整个应用或未挂载内容。声明虚拟内容时消极结论保持无法判定。存在直接反例可判失败；不完整差异不把缺席伪装为删除。

## 动作授权

- `click/fill/select/scroll` 需要 `confirmed: true`。已标记 `data-deviceforge-action="local"` 的节点可在确认后派发；未知节点另需请求级 `allowUnknownSideEffects: true`，双重授权不能绕过其他检查。
- 已知 `device` 永远拒绝自动派发；`read-only`、disabled、CSS 隐藏、不透明、原生表单提交和链接直接点击也拒绝。未知副作用授权并不证明该可信代码不会调用设备，调用者必须理解此独立授权的风险。
- 原生填值先在空白控件上校验，不读取旧值，不支持密码、文件、隐藏或非原生富文本；选择拒绝不存在、重复、禁用和隐藏选项。只派发 input/change，不承诺框架已接受。
- `navigate` 只调用宿主注入且显式白名单内的本地路径，需要确认，不接受外链、查询串或片段。宿主负责路由含义及其副作用。
- `highlight` 临时添加 Tailwind 轮廓类，取消/销毁移除本次新增类；未做视觉验收，不保证动态类已进入宿主样式产物。
- `pickOnce` 最多 30 秒，拦截目标根内的前置手势和一次点击，返回精确节点和 `owner`；其他所有者只归属不自动选择。默认排除 `data-deviceforge-debugger-internal` 自身子树；取消回收监听，不以祖先替代未知节点。同一控制器只允许一个在途拾取。
- `wait` 最多 10 秒，轮询结构断言，支持取消；超时为无法判定，不说明业务失败。

普通动作返回 `businessOutcome: unknown`，一次拾取单独返回状态、目标和所有者。点击只表示合成事件已派发，不保证默认行为、框架接受或业务成功。DOM 合成事件不是真实鼠标，无法阻止更早注册的 document 捕获监听、绕过可信代码副作用或强制终止已开始的回调。

## JSON 与清理

`TreeSnapshot/TreeQuery/TreeAssertion/DebugActionRequest/DebugActionResult` 和 SDK 登记快照只有 JSON 数据。owner、返回快照和元数据深层只读；元数据限制 16KiB、12 层、2048 项，拒绝 getter、循环、非有限数字、函数、类实例和敏感字段名。调用者仍须保证普通字符串不含敏感信息，字段名过滤不是完整脱敏系统。节点/资源各 500 项，事件仅留最近 500 条并记录丢弃数量；registry 返回快照也限制 1MiB。

资源逆序幂等释放；单个释放最多等待 1000 毫秒，失败或超时保留 `release_failed`，`dispose()` 汇总失败，不阻止其余资源。超时不证明底层回调停止。abort 立即撤销登记入口，异步资源随后收敛；bridge/app 应在卸载时销毁 actions 和 collector。模块不启动后台进程、不持久化日志。

## 最小验证

仅运行本模块 4 个明确测试文件：`debugger-registry.test.ts`、`debugger-tree.test.ts`、`debugger-actions.test.ts`、`debugger-contracts.test.ts`。契约测试只检查本目录、SDK 传递依赖及这 4 个测试的严格 TypeScript，不执行整仓检查或构建。jsdom 不证明真实布局、视觉、React 事件链、业务结果、bridge 通信或设备状态。
