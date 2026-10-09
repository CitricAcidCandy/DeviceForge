# 浏览器贡献注册边界

contracts/contributions 校验 SDK v2、命名空间、冲突和模块路由；scope 持有专属取消信号、逆序释放栈及清理错误；manager 串行运行装卸、激活和挂载；extensions 注册开放贡献、调用钩子与管理事件/状态；package-loader 以本代运行路径加载已安装模块。

`createPluginManager({host,panelTarget,componentTarget?,moduleTarget?})` 后登记可信 plugin 或 loader；load 激活、mount 挂载面板，mountComponent/mountModule 使用宿主分配位置。挂载失败回滚整代；卸载立即撤销信号/入口/专属 DOM，串行等待异步清理，错误聚合不阻止其他资源释放。独立 unmount 只撤销面板子生命周期。

可注入 slotAdapter 支持受控 replace，createNamedSlotAdapter 登记宿主默认 renderer。直接 componentTarget 只支持 append，replace 未注入适配器会拒绝；卸载恢复默认渲染由适配器完成，不 monkeypatch 宿主节点。

registerInstalledPackage 通过 app 工厂接入；每次实际 load 创建运行 UUID，依赖资源路径继承此代次。没有内置来源审批或隔离，默认本地可信代码运行；宿主注入 importer/resolver，默认 resolver 使用已安装包运行资源路径。在线包生成契约及 runtime.pluginPackages 上传/目录/启停/删除已实现。永不完成的激活/挂载可能阻塞串行队列，插件必须响应取消。

device-access.ts 为可选 SDK v2 devices 包装所有入口；scope 将插件实例和面板/组件/模块子生命周期信号合并到设备调用，关闭后拒绝 select/snapshot/subscribe，卸载释放订阅并阻止晚通知及旧结果。设备用例和 HTTP 不属于本模块，设备本地准入错误不伪造服务日志 ID。

unload 保留已登记源供重载；unregister 先清理运行代次再撤销源，更新或删除安装包用例可重新登记同 ID。清理失败时源保留并向调用者报告，不假定资源已安全消失。
