# 分包领域端口
SplitPackages 提供按类型化 DeviceSpec 提取分包与向指定设备安装 APKS，返回可下载产物或安装调用结果。输入仅有产物 ID、规格与设备编号，不含工具路径、密钥或服务器 JSON 路径。领域验证规范 UUID、标识、规格数值与列表，公开模式采用同一类型。

`extract_with_context(request, cancel, context)` 增加末参 `ExecutionContext`，传递可选的 `std::time::Instant` 原绝对截止点。默认调用旧 `extract`，兼容旧仅实现者；实际期限覆盖需适配器实现新入口，`Some(D)` 不刷新，`None` 保留旧完整工作预算。本批不新增安装 context 端口，`install` 仍为原签名。

`has_unresolved_resources()` 默认 false，可由适配器覆盖。提取与安装使用同一实例时共享资源风险观测：提取的持久未确认标记可能影响后续安装任务的收口诊断，不能据旧安装端口保留就宣称安装全部行为不变或安装全阶段期限已接通。
