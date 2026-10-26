# 插件包用例编排

构造 `PackageService::new(store: Arc<dyn PackageStore>, plugins: Arc<PluginService>) -> Arc<PackageService>`。服务公开 `list(kind)`、`install(kind, format, stream)`、`install_expected(kind, format, stream, expected_id, expected_version)`、`update(kind, id, format, stream, expected_version)`、`delete(kind, id)`、`asset(id, path)`。

安装先由领域端口准备便携包，再复用 `registration::validate_operations`，最后发布。服务器删除与 PluginService load/unload 共用有界、串行、可跟踪变更队列；仍 loaded/draining 时拒绝删除，历史 cleanup_failed 仅保留诊断。客户端丢弃删除请求后，已经接收的变更仍由同一跟踪器收敛。

市场安装和更新在发布前校验真实包身份与期望版本；更新必须匹配路径 ID。更新完整准备与验证后也进入同一管理队列，拒绝仍 loaded/draining 的服务器部署，不因历史 cleanup_failed 永久封锁，再调用存储的安全替换。普通安装仍拒绝覆盖，更新失败不先删除旧包，也不自动加载新包。

本模块不读取归档、不映射程序路径、不加载浏览器模块；部署删除与运行卸载分开。

注册验证独立使用 2 槽阻塞池，许可和 Prepared 都移入阻塞闭包；取消 HTTP 等待不释放仍运行的后台验证名额。上传、展开和验证的安装期限合计 120 秒。

发布或删除已进入阻塞工作后，丢弃客户端等待不撤回原子目录变更；调用方应通过安装列表核对最终状态。此前阶段取消只清理本次暂存，不发布半包。
