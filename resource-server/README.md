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

- `GET|HEAD /api/v1/capabilities`：只读能力探测，返回 `api_version:1` 与完整发布支持；浏览器应在上传前确认能力，缺接口或版本不兼容时提示升级，并停止资源写入。
- `GET /api/v1/catalog`：组合筛选、FTS5 前缀检索和分页；内部资源默认隐藏。
- `POST /api/v1/catalog`：校验并发布 `market.json`，同一 ID/版本拒绝覆盖。
- `POST /api/v1/resources`：流式上传并按 SHA-256 原子发布，使用 `x-resource-filename`、`x-resource-kind` 描述内容。
- `GET|HEAD /api/v1/resources/{sha256}`：支持 ETag、Range、Content-Length 和 Content-Range。
- `GET /api/v1/resources/{sha256}/meta`：读取资源 MIME、大小、文件名和摘要。

完整功能发布沿用这组接口：先上传组件与工具，再上传固定摘要的 `release.json`，最后提交一个市场条目。条目使用 `resource_id` 引用清单，`details.release_format_version=1`、`details.host_api_version=2` 标记完整发布；内部组件和工具不另外生成可见功能卡片。提交前服务核对清单身份、组件/工具资源是否齐全及各自大小；同一 ID/版本发布后禁止替换内容，删除目录条目也不清除原身份绑定。统一打包与发布命令见 [发布工具说明](../scripts/plugin-releases/README.md)。

能力响应固定为 `{"api_version":1,"release_publication":{"format_versions":[1],"host_api_versions":[2],"resource_max_bytes":2147483648,"catalog_last":true,"immutable_versions":true}}`，资源限额与上传处理共用常量。`capabilities.rs` 只生成该声明，`http.rs` 负责路由和传输，`releases.rs` 核对完整发布闭包，`store.rs` 保存资源、目录和永久版本身份。没有服务器接收 ZIP 后解包发布的额外接口；离线 ZIP 的解析和资源编排由调用方完成。

任一完整发布 marker 出现时，两项 marker 都必须为受支持的整数，且条目类型为 `plugin`。所有组件与工具变体必须已上传，清单路径须直接引用同服务摘要，元数据大小和真实文件长度均须匹配。落目录前还会以有界缓冲流式重算每份组件和工具的 SHA-256，拒绝同长度字节损坏；单次提交中相同摘要与长度的资源只读取一次，所有平台和已声明的可选工具变体同样需要通过。缺资源或校验失败不创建目录条目，也不预占永久版本身份；失败前已上传的内容寻址资源可保留，不承诺事务回滚。已绑定的完整发布 ID/版本在删除和重启后仍拒绝另一清单或无 marker 的降级条目；相同原清单允许重新上架，其他尚未绑定的旧条目接口继续兼容。

资源 GET、HEAD 和 ETag 条件请求共用真实文件存在性与长度检查，文件丢失返回 404，文件长度与元数据不符返回 500，不以成功 HEAD 或 304 掩盖存储损坏。HEAD 仍不返回正文，也不读取完整文件计算摘要；浏览器下载校验和发布闭包校验各自保留。目录提交增加的流式读取成本需在正式部署环境单独测量，不视为性能已验收。

验证入口为 `cargo test --manifest-path resource-server/Cargo.toml`。`tests/publication_http.rs` 直接调用真实路由，覆盖能力 GET/HEAD、浏览器 CORS 预检、资源 HEAD/Range/ETag、完整多平台闭包、组件/工具及清单摘要与长度不符、marker/身份拒绝、失败不预占身份、删除重启后的永久绑定及旧资源兼容，不启动部署端口，也不代表网页或正式发布已验收。

中文文件名上传时，将 `x-resource-filename` 设为 UTF-8 百分号编码，并附加 `x-resource-filename-encoding: percent`；下载响应使用同样的标记。没有编码标记的旧文件名按原样处理。跨域响应公开文件名、摘要等响应头，浏览器可读取并执行摘要校验。

旧独立资源提交入口最多暂存 256 MiB，超限明确提示；完整离线插件包由浏览器直接流式上传到宿主 `/api/v2/plugin-installations/artifacts`，上限 4 GiB，再进入统一安装任务。资源服务单资源上传上限为 2 GiB，下载支持 Range。工具文件保存在运行宿主的用户根，局域网客户端只访问宿主提供的浏览器组件；资源服务不执行工具。服务端容量与性能需要按部署环境独立测量。

服务默认免鉴权；部署到局域网或公网时应由上层网关提供访问控制。插件安装仍须经过现有安装器和摘要校验。
