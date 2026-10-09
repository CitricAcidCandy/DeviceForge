# 插件产物能力适配器

## 作用与快速开始
为协议版本 2 的进程插件准备经过完整性校验的输入副本与独占输出目录，执行后发布插件生成文件。适用于转换、分析、截图处理等需要二进制产物的公开插件操作。

在后端执行 `cargo test -p apk-infrastructure plugin_artifacts`；端到端示例见 plugins/artifact-copy。服务通过 plugins::load_with_artifacts 装配领域 ArtifactStore，不把服务令牌交给插件。

## API 与参数
- validate(access)：检查管理员清单的输入字段数量、名称及唯一性。
- InvocationFiles::prepare(store, access, input, cancel)：只解析清单声明的顶层输入字段；值为产物 ID 字符串或字符串数组，缺失字段跳过。
- InvocationFiles::publish(store, outputs, cancel)：检查权限、文件名、普通文件与容器，再流式发布；返回领域产物元数据。

单次最多 8 个输入产物，声明输入字段最多 8 个；输入元数据总量最多 64 MiB。复制前通过共享 artifact_files 校验 SHA-256 与大小。每次调用使用独占临时工作目录，输入路径指向副本，不是持久化产物目录。插件修改副本不会通过宿主端口修改原产物。

单次最多 8 个输出，声明文件的总大小最多 64 MiB。filename 为单一显示文件名，拒绝路径、链接、目录、未知后缀与大小写折叠后重复名称。允许的类型沿用产物服务：APK / APKS / AAB / HAP / ZIP / PNG。先校验所有声明文件，再逐个发布；存储或取消在发布期间失败时，已经发布的文件可能保留，当前没有跨产物事务回滚。

## 协议与边界
协议 1 保持原请求与原结果；协议 2 Request.artifacts 提供 inputs 和可选 output_directory，Response.outputs 仅声明已生成的文件名。协议 2 任务成功结果固定为 PluginArtifactResult：result 加 artifacts 数组，空输出也保持此结构。

准备与发布阶段各最多 120 秒，插件进程最多 60 秒；请求最多 512 KiB，标准输出与错误各最多 1 MiB。协议 2 进程的工作目录与 TEMP / TMP / TMPDIR 指向本次调用目录，环境仍不继承 API 令牌。取消会触发工具停止和临时目录清理。

产物能力是宿主端口的授权与路径限制，不是操作系统沙箱；插件运行于服务账户权限，必须由管理员信任和部署。当前没有插件磁盘硬配额、网络隔离、派生进程树完整回收及多输出事务。允许权限不会改变浏览器 / MCP 的统一鉴权机制。

## 验证
Rust 测试覆盖声明字段、数量、未授权、越界名称、文件类型、体积、批量预校验、临时目录清理和真实协议子进程。Unix 专有链接测试不在 Windows 执行。示例插件的独立进程测试覆盖 PNG 字节复制、宿主发布、权限缺失和输入篡改；runtime-smoke.mjs 覆盖真实 HTTP / MCP 调用及下载。
