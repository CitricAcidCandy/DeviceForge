# 在线部署包基础用例

公开入口 createPluginPackages：refresh/snapshot/subscribe 读取两类部署目录；upload 上传原始 ZIP/GZIP 并返回生成 PackageInfo；enable/disable 显式改变运行状态；remove 先停用并清理，再删除部署包。上传不自动执行代码，浏览器与服务器运行状态分别处理。

所有 DTO/路径参数/媒体类型来自 generated paths。跨功能回调由 app 注入，不导入 server-plugins 或 plugins 内部。操作串行，失败/取消后用独立生命周期重查部署目录；已接收的安装/删除不能推断回滚，也不自动重放。管理成功但目录重查失败仍会报告错误，部署可能已改变。

浏览器启用从安装目录映射独立 SDK 描述，按运行 UUID 资源前缀加载；主代理注入原生 ESM importer。服务端删除前查询是否正在运行，受保护/draining/cleanup_failed 状态由后端拒绝并保留。浏览器 remove 撤销加载源后调用 DELETE，失败后仍可从实际安装目录重新启用。
