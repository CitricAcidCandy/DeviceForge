# 后端开发与运行验收工具

`node scripts/check-architecture.mjs` 使用 Cargo 元数据检查生产依赖方向、独立插件和公开 SDK 边界。开发依赖允许使用真实适配器进行集成测试；未知模块与领域新增外部依赖必须先补充职责规则。门禁不判断算法、线程阻塞、资源生命周期或标准库文件访问，这些由代码审查与行为测试验证。

`node --test scripts/architecture.test.mjs` 验证越层生产依赖、构建依赖、插件引用宿主及工程外路径依赖会被拒绝。

`node scripts/runtime-smoke.mjs` 在独立临时目录启动真实 HTTP/MCP 服务和插件进程，并使用模拟设备工具验证任务及产物。追加 `--performance-plugin` 验证公开性能探针部署。`msgpack-smoke.mjs` 专门验证标准 MessagePack 贡献。模拟工具通过不代表真机、私有 DLL 格式或生产性能通过。

`node scripts/plugin-lifecycle-smoke.mjs` 验证空插件启动后的部署、HTTP/MCP 加载/卸载/重载、新代际、历史任务保留、4 个独立进程取消退出与 1 个排队任务取消、过期 MCP 分页、鉴权/清单拒绝、日志关联及正常停止。支持 --release，报告写根 artifacts；本机耗时只作本轮观察，不是负载性能结论，不包含设备提供者或常驻协议。
