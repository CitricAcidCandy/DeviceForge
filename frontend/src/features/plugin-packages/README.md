# 在线部署包基础用例

## 当前目录分层

根目录仅保留本说明与 `index.ts` 公开门面，外部应用按门面消费。原用例实现从根索引迁入 `application/`，原导出保持兼容。已有算法行为与协议保持，内部文件路径已按职责整理。

- `application/`：用例、状态、目录与生命周期编排；HTTP装配工厂也放在此层，基础设施不反向依赖用例。

允许依赖为 application → domain/infrastructure，infrastructure → domain，ui → application/domain；domain 不依赖用例、适配或界面。纯规则现有共享API类型和错误保留过渡，不新增HTTP调用。

公开入口 createPluginPackages：refresh/snapshot/subscribe 读取两类部署目录；upload 上传原始 ZIP/GZIP 并返回生成 PackageInfo；enable/disable 显式改变运行状态；remove 先停用并清理，再删除部署包。上传不自动执行代码，浏览器与服务器运行状态分别处理。

所有 DTO/路径参数/媒体类型来自 generated paths。跨功能回调由 app 注入，不导入 server-plugins 或 plugins 内部。操作串行，失败/取消后用独立生命周期重查部署目录；已接收的安装/删除不能推断回滚，也不自动重放。管理成功但目录重查失败仍会报告错误，部署可能已改变。

浏览器启用从安装目录映射独立 SDK 描述，按运行 UUID 资源前缀加载；主代理注入原生 ESM importer。服务端删除前查询是否正在运行，受保护/draining/cleanup_failed 状态由后端拒绝并保留。浏览器 remove 撤销加载源后调用 DELETE，失败后仍可从实际安装目录重新启用。

销毁先关闭整个模块的刷新与订阅准入，再分别关闭服务器和浏览器目录；取消回调同步重入另一目录时也不得产生通知、请求或新订阅。关闭后的刷新继续以异步取消错误结束。
