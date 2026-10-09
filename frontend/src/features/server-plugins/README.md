# 服务器插件管理用例

只消费生成契约和公开 ID；load/unload 进入串行队列，返回后重新读取插件目录，并调用 app 注入的 refreshPublished(signal,id) 协调公开目录。取消或管理失败也用独立生命周期重查，不推断变更回滚、不自动重放。cleanup_failed、draining、generation、protected 保留后端语义；不提供路径安装、强制卸载或浏览器插件入口。

成功管理后目录查询失败会抛出重查错误，此时变更可能已生效。取消返回仍等待受控重查完成；销毁停止重查。app/catalog-refresh 先撤销目标设备缓存与选择，再重查操作和设备目录；失败也不保留旧观测。本功能不导入其他 features 内部实现，在线包上传/删除由 features/plugin-packages 公开入口与 app 生命周期编排负责。
