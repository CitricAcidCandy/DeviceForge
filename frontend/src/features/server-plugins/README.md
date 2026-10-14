# 服务器插件管理用例

## 当前目录分层

根目录仅保留本说明与 `index.ts` 公开门面，外部应用按门面消费。原用例实现从根索引迁入 `application/`，原导出保持兼容。已有算法行为与协议保持，内部文件路径已按职责整理。

- `application/`：用例、状态、目录与生命周期编排；HTTP装配工厂也放在此层，基础设施不反向依赖用例。

允许依赖为 application → domain/infrastructure，infrastructure → domain，ui → application/domain；domain 不依赖用例、适配或界面。纯规则现有共享API类型和错误保留过渡，不新增HTTP调用。

只消费生成契约和公开 ID；load/unload 进入串行队列，返回后重新读取插件目录，并调用 app 注入的 refreshPublished(signal,id) 协调公开目录。取消或管理失败也用独立生命周期重查，不推断变更回滚、不自动重放。cleanup_failed、draining、generation、protected 保留后端语义；不提供路径安装、强制卸载或浏览器插件入口。

成功管理后目录查询失败会抛出重查错误，此时变更可能已生效。取消返回仍等待受控重查完成；销毁停止重查。app/catalog-refresh 先撤销目标设备缓存与选择，再重查操作和设备目录；失败也不保留旧观测。本功能不导入其他 features 内部实现，在线包上传/删除由 features/plugin-packages 公开入口与 app 生命周期编排负责。
