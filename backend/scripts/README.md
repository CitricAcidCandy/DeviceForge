# 后端开发与运行验收工具

`node scripts/check-architecture.mjs` 使用 Cargo 元数据检查生产依赖方向、独立插件和公开 SDK 边界。开发依赖允许使用真实适配器进行集成测试；未知模块与领域新增外部依赖必须先补充职责规则。门禁不判断算法、线程阻塞、资源生命周期或标准库文件访问，这些由代码审查与行为测试验证。

`node --test scripts/architecture.test.mjs` 验证越层生产依赖、构建依赖、插件引用宿主及工程外路径依赖会被拒绝。

`node scripts/runtime-smoke.mjs` 在独立临时目录启动真实 HTTP/MCP 服务和插件进程，并使用模拟设备工具验证任务及产物。追加 `--performance-plugin` 验证公开性能探针部署。`msgpack-smoke.mjs` 专门验证标准 MessagePack 贡献。模拟工具通过不代表真机、私有 DLL 格式或生产性能通过。

`node scripts/plugin-lifecycle-smoke.mjs` 验证空插件启动后的部署、HTTP/MCP 加载/卸载/重载、新代际、历史任务保留、4 个独立进程取消退出与 1 个排队任务取消、过期 MCP 分页、鉴权/清单拒绝、日志关联及正常停止。支持 --release，报告写根 artifacts；本机耗时只作本轮观察，不是负载性能结论，不包含设备提供者或常驻协议。

`node scripts/cooperative-smoke.mjs` 对协议 3 的真实 Rust cooperative_demo 插件分别启动 complete、ignore、failed 三种场景。每次先启动空部署目录，再由测试部署者写清单和受控标记目录参数；HTTP/MCP 请求仅传插件 ID 或业务等待时间。正常卸载返回时必须已有 cleaned 标记且原生进程退出；忽略取消或明确清理失败必须返回 HTTP 409 / cleanup_failed，保留 draining + cleanup_failed 状态，撤销 HTTP/MCP 操作，拒绝重复卸载和重载。核对 cancelled 历史任务、两种传输的插件列表和日志 ID、真实 JSONL 资源告警及正常关闭。只清理本次临时目录及自有宿主进程；若插件进程仍可见，保留本次目录并失败，不按可复用 PID 强杀。

合作 smoke 不自动调用 Cargo。须先由集成负责人统一构建 apk-server 和 deviceforge-cooperative-demo-plugin 的当前代码；支持 `--release`，分别使用 backend/target/debug 或 backend/target/release 中的两个程序。可以从根目录运行 `node backend/scripts/cooperative-smoke.mjs --release`，报告始终写到根 artifacts/cooperative-smoke-{profile}.json，包括失败场景及已验证的受控日志字段。脚本编写和 Node 语法检查不等于真实 HTTP/MCP 验收；不包含 Frida、常驻插件、设备提供者或真机。

失败报告保留最后请求的路径、状态、日志 ID 与耗时，以及管理响应预期/实际代码、卸载耗时、断言位置、取消和清理标记时间、进程退出观测及关闭后落盘事件摘要。诊断不改变生产清理期限、成功断言或失败模式，不自动重试失败场景；不保存令牌、原始业务请求或任意插件输出。

本脚本验证可信插件部署路径，显式配置令牌以回归可选鉴权。最新部署目标为本地/LAN 默认免鉴权、令牌可选，在线包按可信扩展处理；默认启动规则由集成负责人同步，当前脚本不验收在线安装能力。
