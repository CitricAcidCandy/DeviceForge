# 在线包 HTTP 装配

模块读取 `ApiState.packages: Option<Arc<PackageService>>`，未配置返回 503。主装配保留 RuntimeServices 结构，增加 packages 注入。

- `list(State<ApiState>, Result<Path<PackageKind>, PathRejection>)`：GET `/api/v2/plugin-packages/{kind}`。
- `install(State<ApiState>, Result<Path<PackageKind>, PathRejection>, Result<Query<UploadQuery>, QueryRejection>, HeaderMap, Body)`：POST 同路径，query format 必填，application/zip 或 application/gzip 原字节；本路由 body 上限单独设置 64 MiB。
- `delete(State<ApiState>, Result<Path<(PackageKind,String)>, PathRejection>)`：DELETE `/api/v2/plugin-packages/{kind}/{id}`。
- `update`：PUT `/api/v2/plugin-packages/{kind}/{id}?format=zip|tgz`，验证完整新包后替换部署，失败恢复旧部署；服务器插件仍运行或清理未确认时拒绝。
- `asset(State<ApiState>, Result<Path<(String,String)>, PathRejection>)`：GET/HEAD `/api/v2/browser-plugins/{id}/assets/{*path}`。
- `run_asset(State<ApiState>, Result<Path<(String,String,String)>, PathRejection>)`：GET/HEAD `/api/v2/browser-plugins/{id}/runs/{run_id}/assets/{*path}`。

上传与更新允许可选 `expected_id`、`expected_version`，在发布前核对包内真实声明；更新的路径 ID 也是强制期望身份。同版本更新返回冲突。路径和查询提取器的拒绝统一转成 ApiError；非法 kind、缺失/非法/重复 format 和额外 query 返回 400/invalid_input，并保留 v2 的 log_id/error。

管理返回 Json，由现有 correlation/envelope 处理 v2 包装。两个资产 handler 返回 Response 并附 `responses::RawRepresentation`、媒体类型、长度、no-store、nosniff；所有成功静态资源包括 JSON 保留原字节。配置令牌后也仅放行两个静态 GET/HEAD，用于原生 ES 模块相对导入；包是公开可信代码，不含 secret，管理和数据权限仍由宿主可选令牌控制。
