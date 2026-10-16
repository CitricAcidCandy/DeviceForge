# DeviceForge 资源服务

资源服务与 `backend/` 同级，默认监听 `127.0.0.1:7040`，使用 SQLite FTS5 管理 `market.json` 元数据，使用内容寻址目录保存图片、MP4、音频、模型、npx 分发包等字节。

资源服务独立构建、部署和启动；npx 启动器只通过市场地址访问它。可在项目根目录执行 `npm run start:resource-server`，或使用以下命令指定数据目录：

```powershell
cargo run --release --manifest-path resource-server/Cargo.toml -- --bind 127.0.0.1:7040 --data-dir C:\DeviceForge\market-data
```

`--data-dir` 指定资源服务的父目录。服务启动时会自动创建 `plugin`、`tool`、`config`、`distribution`、`resource` 五个分类目录，以及内容寻址用的 `blobs` 和临时文件用的 `tmp`。上传仍按 SHA-256 保存在 `blobs` 中，分类目录用于后续包、配置和资源的管理扩展，不需要预先手动创建。

Windows 下如果使用已经编译好的程序：

```powershell
.\deviceforge-resource-server.exe --bind 127.0.0.1:7040 --data-dir C:\DeviceForge\market-data
```

执行 `.\deviceforge-resource-server.exe -h` 或 `--help` 可查看参数含义、默认值和示例。帮助命令直接退出，不启动服务或创建数据目录。

主要接口：

- `GET /api/v1/catalog`：组合筛选、FTS5 前缀检索和分页；内部资源默认隐藏。
- `POST /api/v1/catalog`：校验并发布 `market.json`，同一 ID/版本拒绝覆盖。
- `POST /api/v1/resources`：流式上传并按 SHA-256 原子发布，使用 `x-resource-filename`、`x-resource-kind` 描述内容。
- `GET|HEAD /api/v1/resources/{sha256}`：支持 ETag、Range、Content-Length 和 Content-Range。
- `GET /api/v1/resources/{sha256}/meta`：读取资源 MIME、大小、文件名和摘要。

服务默认免鉴权；部署到局域网或公网时应由上层网关提供访问控制。插件安装仍须经过现有安装器和摘要校验。
