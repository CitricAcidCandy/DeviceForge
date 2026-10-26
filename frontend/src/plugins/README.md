# 浏览器贡献注册边界

contracts/contributions 校验 SDK v2、命名空间、冲突和模块路由；scope 持有专属取消信号、逆序释放栈及清理错误；manager 串行运行装卸、激活和挂载；extensions 注册开放贡献、调用钩子与管理事件/状态；package-loader 以本代运行路径加载已安装模块。

`createPluginManager({host,panelTarget,componentTarget?,moduleTarget?})` 后登记可信 plugin 或 loader；load 激活、mount 挂载面板，mountComponent/mountModule 使用宿主分配位置。挂载失败回滚整代；卸载立即撤销信号/入口/专属 DOM，串行等待异步清理，错误聚合不阻止其他资源释放。独立 unmount 只撤销面板子生命周期。

可注入 slotAdapter 支持受控 replace，createNamedSlotAdapter 登记宿主默认 renderer。直接 componentTarget 只支持 append，replace 未注入适配器会拒绝；卸载恢复默认渲染由适配器完成，不 monkeypatch 宿主节点。

槽位适配器另有晚注册入口 `slots.define({id,target,modes?,renderDefault?})`：`renderDefault` 省略即「纯挂载点」——宿主用 React 自己渲染默认内容，槽位只负责托管插件根与租约，进出 DOM 都不留空节点。`modes` 由宿主装配处传入（`app/product/slots.ts` 是唯一真源），`plugins/**` 不读宿主清单，所以保护名单（市场、设置只允许 append）在装配处生效、不在插件运行时生效。`define` 返回的 `Dispose` 先释放该槽的全部租约再移除登记，重复 id 抛错。

模块也走槽位：`ModuleContribution` 没有 `slot` 字段，`mountExtension` 用 `pageSlotId(pluginId, route)` 派生 `page.<插件ID>.<页面>` 并同样申请租约；`moduleTarget` 退化为没有适配器时的兜底。派生用的归一化函数在 `plugin-sdk/slots.ts`，宿主路由解析与插件运行时共用同一份，否则两边算出的键对不上就会「挂载成功但看不见」。

registerInstalledPackage 通过 app 工厂接入；每次实际 load 创建运行 UUID，依赖资源路径继承此代次。没有内置来源审批或隔离，默认本地可信代码运行；宿主注入 importer/resolver，默认 resolver 使用已安装包运行资源路径。在线包生成契约及 runtime.pluginPackages 上传/目录/启停/删除已实现。永不完成的激活/挂载可能阻塞串行队列，插件必须响应取消。

device-access.ts 为可选 SDK v2 devices 包装所有入口；scope 将插件实例和面板/组件/模块子生命周期信号合并到设备调用，关闭后拒绝 select/snapshot/subscribe，卸载释放订阅并阻止晚通知及旧结果。设备用例和 HTTP 不属于本模块，设备本地准入错误不伪造服务日志 ID。

主题目录位于 `themes/`：rules 负责声明限额与冻结，registry 负责 owner/generation、显式选择和撤销，dom 仅适配注入的目标节点。主题契约与行内变量基线恢复见 [主题插件与宿主样式](../../docs/主题插件与宿主样式.md)。

artifact-access.ts 对可选 SDK v2 artifacts 的上传/下载做作用域代理，只调用现有 call/current 门禁；旧宿主缺省时不补实现。scope 同时约束实例和挂载子生命周期，预取消或关闭零调用、晚到成功拒绝；原 Blob 与日志不重包、不创建 URL。HTTP/DTO 校验属于宿主网关，上传 Abort 不承诺服务器回滚或删除产物。新增回归待主代理统一执行，真实浏览器证据另验。

task-history-access.ts 对可选 SDK v2 taskHistory 的 list/get/events 做独立代理，现有 scope 的 call/current 合并实例及挂载子生命周期；复用 awaitActive 及时结束无视取消的旧宿主等待，并消费晚 resolve/reject。子作用域退出不关闭兄弟，重载不复活旧引用；宿主资格与元数据校验归 app 网关。代理不创建缓存、定时器或订阅，不删除历史或取消服务器 Job。独立回归待主代理统一执行，未借用旧浏览器报告宣称本批已验证。

unload 保留已登记源供重载；unregister 先清理运行代次再撤销源，更新或删除安装包用例可重新登记同 ID。清理失败时源保留并向调用者报告，不假定资源已安全消失。
