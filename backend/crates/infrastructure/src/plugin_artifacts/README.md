# 插件产物能力适配器

## 作用与快速开始
为协议版本 2/3 的进程插件准备经过完整性校验的输入副本与独占输出目录，执行后发布插件生成文件。设备动作可以从标准封套的业务 input 中选择产物 ID，不向业务请求开放服务器路径。

在后端执行 `cargo test -p apk-infrastructure plugin_artifacts`；端到端示例见 plugins/artifact-copy。服务通过 plugins::load_with_artifacts 装配领域 ArtifactStore，不把服务令牌交给插件。

## API 与参数
- selectors：不访问存储的纯规则模块，校验清单并返回原选择器标签与产物 ID；由父模块统一委托。
- validate(access)：检查 input_fields 与 input_pointers 的名称、路径、合计数量及唯一性。
- InvocationFiles::prepare(store, access, input, cancel)：先完成全部声明和值的纯校验，再创建临时目录、读取存储及复制；缺失 access 时不选择输入。
- InvocationFiles::publish(store, outputs, cancel)：检查权限、文件名、普通文件与容器，再流式发布；返回领域产物元数据。

旧 input_fields 只选择顶层原名称；新增 input_pointers 使用 RFC 6901，例如 `/input/artifact_id`、`/input/items/0`。路径必须以 `/` 开头，支持 `~0`、`~1` 和 Unicode，最多 256 UTF-8 字节、8 段，不支持空根、通配符或 URI 片段。数组索引必须为规范十进制整数；合法超界索引视为缺失。

缺失路径跳过，终值只能是字符串或全字符串数组；null、对象、数字、混合数组、非容器中间值及非法数组索引均拒绝。未声明的 ID 不读取。两类选择器合计最多 8 个，重复及顶层字段与等价 `/field` 冲突拒绝；实际引用最多 8 个，输入元数据合计最多 64 MiB。相同 ID 在不同选择器下按引用分别计数、复制并保留标签，嵌套标签保留原 JSON Pointer。

共享 artifact_files 在复制时校验 SHA-256 与大小。每次调用使用独占临时工作目录，输入路径指向副本。业务 input 保持原 ID，副本路径仅进入 Request.artifacts；修改副本不会通过宿主端口修改原产物。取消可中止元数据等待及复制，调用目录与输入副本由守卫清理。

单次最多 8 个输出，声明文件的总大小最多 64 MiB。filename 为单一显示文件名，拒绝路径、链接、目录、未知后缀与大小写折叠后重复名称。允许的类型沿用产物服务：APK / APKS / AAB / HAP / ZIP / PNG / JSON / MSGPACK。先校验所有声明文件，再逐个发布；存储或取消在发布期间失败时，已经发布的文件可能保留，当前没有跨产物事务回滚。

## 协议与边界
协议 1 保持原请求与原结果并拒绝产物声明；协议 2/3 Request.artifacts 提供 inputs 和可选 output_directory，Response.outputs 仅声明已生成的文件名。协议 2/3 任务成功结果固定为 PluginArtifactResult：result 加 artifacts 数组，空输出也保持此结构。协议 3 沿用合作响应包装和清理确认，不修改旧 DTO；性能采样插件不得声明任何非空 input_fields、input_pointers 或输出权限。

通用准备与发布阶段各最多 120 秒，协议 2 插件进程最多 60 秒；协议 3 沿现有合作传输期限和清理预算。设备动作仍受包括排队的 30 秒总期限约束，本项不扩大设备安装时限，也不保证所有真实大包可在该期限内完成。请求最多 512 KiB，标准输出与错误各最多 1 MiB。产物进程的工作目录与 TEMP / TMP / TMPDIR 指向本次调用目录，环境不继承 API 令牌。

产物能力是宿主端口的授权与路径限制，不是操作系统沙箱；在线插件按可信代码运行于服务账户权限。默认免鉴权，APK_API_TOKEN 可选，产物声明不改变该部署规则。当前没有插件磁盘硬配额、网络隔离、派生进程树完整回收及多输出事务。协议 3 缺清理确认或 Future 丢弃仍保留未确认标记，不能把直接进程退出当作外部资源清理证明。

## 验证
本模块测试包含真实副本字节与摘要、重复 ID 独立副本、混合数量/大小、未声明不读、坏值在读取前拒绝、取消及目录清理；plugins 测试检查性能门禁，plugin_packages 集成测试检查 ZIP/TGZ 协议 2/3 声明保留和无效清单拒绝。device_providers 集成夹具启动真实 Node 进程，覆盖模拟设备封套、副本与输出、取消控制和 Future 丢弃；协议 3 刻意等待 stdin EOF 再退出。Unix 专有链接测试不在 Windows 执行。

上述嵌套产物新增测试已由主代理纳入 208 项 Rust 工作区门禁并通过；debug/release HTTP/MCP 集成各 42 项检查通过，真实 npx 安装两协议包的嵌套输入、输出和在途热装卸也通过。报告见根 artifacts/nested-device-artifacts-smoke-*.json。模拟设备不能代表 Android/Harmony 平台迁出、常驻连接、iOS 或真机已经完成。
