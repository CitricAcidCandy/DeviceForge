# 应用用例与任务调度

作用：装配公开操作贡献，验证 JSON 输入，调度可取消任务并保存状态和事件。适用于内置工具与跨语言插件的统一执行入口。

快速开始：在后端目录执行 `cargo test -p apk-application`。

API：`Application::new(store, executors, concurrency, capacity)` 检查注册冲突并恢复中断任务；`operations` 返回运行时贡献；线上提交、查询、事件与取消使用 `submit_async/get_async/list_async/events_async/cancel_async`；`shutdown` 停止接收、取消并等待已有任务退出。

`browser_configurations.rs` 只编排合法插件ID、完整记录与修订比较存储端口，不依赖部署目录、文件或浏览器生命周期；未在线安装的随包插件也可保存配置。契约见 [浏览器插件用户配置](../../docs/contracts/浏览器插件用户配置.md)。

同步领域存储端口保留，线上访问由 `blocking.rs` 限制最多 4 个 `spawn_blocking` 工作。许可由工作闭包持有，取消等待者不能提前释放仍在执行的名额。日志上下文和 span 同时传播至阻塞线程与后台任务。原同步方法仅供工作池、启动和兼容测试使用，禁止从 HTTP/MCP 请求线程直接调用。

任务容量包含排队和运行任务。所有执行器受同一个并发上限约束。输入使用注册时编译的 JSON Schema 验证器；只允许文档内引用，避免模式解析访问外部资源。取消的终态由存储端口保护，晚到结果不能覆盖。服务装配应只创建一个应用实例，禁止对共享任务库重复恢复。

产物贡献：artifacts::ArtifactOperations 使用可注入 ArtifactStore 贡献 artifact.inspect 和 artifact.archive.entries，供 HTTP 任务与 MCP 共用。

## 注册快照与插件生命周期

registry.rs 负责完整贡献校验、原子发布、修订、独立代际、取消树与任务跟踪。它不读取部署文件、不启动进程；提交在准入时核对快照身份，防止卸载/重载后使用旧验证结果。最多 256 个动态插件、4096 项总操作；模式编译由应用的受限工作池完成。

plugin_lifecycle.rs 通过领域 PluginCatalog 编排 load/unload，最多 2 个在途管理工作，变更串行。客户端取消等待不取消已经接收的变更；close 与管理准入线性化，wait 等待收敛。seed 只用于监听前装配。卸载先撤销新调用，再取消并等待任务，10 秒超时保留 draining；被启动性能探针引用的插件受保护。

任务取消给予执行器最多 2 秒合作清理，再丢弃 Future，最终状态固定为取消。tests/plugin_lifecycle.rs 覆盖冲突不留半份贡献、排队/运行取消及清理、管理请求取消、关闭准入和保护依赖；registry 单测覆盖同 ID 重载的旧快照拒绝。具体契约见 ../../docs/运行中插件生命周期.md。
# 注册契约的离线复用

registration.rs 统一编译操作命名空间和本地输入模式。Application 启动调用同一编译逻辑，管理员插件安装通过 validate_operations 校验贡献；离线检查不创建任务、不恢复数据库、不执行插件。tests/registration.rs 验证命名空间、重复操作、外部引用与非法模式拒绝。

