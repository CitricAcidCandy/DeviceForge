# 在线插件包公开契约

`PackageKind` 为 `server|browser`，`PackageFormat` 为 `zip|tgz`。`PackageInfo` 返回 `kind/id/version/runtime/entry_path/entry_url/api_version/installed_at`；`entry_path` 是包内相对入口，浏览器 `entry_url` 指向同包资源路径，服务器不返回机器程序路径。

| 端点 | 输入 | 输出 |
| --- | --- | --- |
| GET `/api/v2/plugin-packages/{kind}` | 包种类 | v2 包装的已安装 `PackageInfo[]` |
| POST `/api/v2/plugin-packages/{kind}?format=zip|tgz` | 原字节、自包含归档；Content-Type 为 application/zip 或 application/gzip | 201，v2 包装的 `PackageInfo` |
| DELETE `/api/v2/plugin-packages/{kind}/{id}` | 包种类和 ID | v2 包装的已删除 `PackageInfo` |
| GET `/api/v2/browser-plugins/{id}/assets/{*path}` | 已安装浏览器包内相对路径 | 原字节、正确媒体类型和关联响应头；成功不套 JSON |
| GET `/api/v2/browser-plugins/{id}/runs/{run_id}/assets/{*path}` | 客户端每次启用的独立 run_id 和包内路径 | 同一公开静态资源；相对依赖沿运行前缀形成独立 ES 模块图 |

ZIP 根目录和 npm TGZ 的 `package/` 目录内均包含 `package.json.deviceforge={kind,manifest,entrypoints}`。包版本与插件清单版本一致；服务器清单沿用协议 1/2/3 且禁止 executable，入口 native/node 由宿主平台选择并生成绝对路径；浏览器清单为 `{id,version,api_version:2}`，`entrypoints.any={runtime:"browser",path:"...js"}`。

`PackageStore` 只负责部署：流式准备、原子发布、列表、删除、资源读取。准备结果暴露操作贡献供应用层复用注册门禁，准备或验证阶段失败、Future 丢弃不发布。发布已进入阻塞工作后，丢弃等待不撤回原子变更，调用方须查询安装列表核对结果。安装不执行包脚本、不安装依赖、不自动加载。同 ID 不覆盖。

静态模块是公开的已发布可信代码，读取不等于业务管理权限；配置令牌时管理/业务接口按宿主检查，ES 模块及相对资源无需携带令牌。包中禁止混入宿主令牌或运行数据。本契约不提供常驻会话或系统隔离。

两个资产路径均支持 GET/HEAD，OpenAPI `security: []`；成功响应附 RawRepresentation，JSON 文件也保留原字节。run_id 为 1–100 字节的 ASCII 字母数字、下划线或连字符，客户端通常生成 UUID；服务器只校验 URL，不保存运行用户会话。
