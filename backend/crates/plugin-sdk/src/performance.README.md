# 性能声明纯契约

`performance.rs` 提供 `PerformanceAccess`、`PerformanceDeviceCapability` 与纯 `validate()`，根模块继续导出原 `PerformanceAccess` 名称。SDK 不查注册表、编译 schema、读取时钟、启动工具或持有会话。

API 1 省略 `api_version` 时默认 1，序列化值 1 时省略，保留旧声明外形；`fps` 仍默认 false。API 1 不能绑定设备能力。API 2 必须显式携带 `{id,version}` 引用，引用严格拒绝未知字段、标识最多 100 字节且遵守既有 ASCII 标识资格、版本为非零 u32。未知版本、错误类型、重复字段或冲突绑定反序列化失败；Rust 字面量须调用 `validate()`。

宿主另行校验：API 1 仅协议 2、沿用全插件禁产物规则；API 2 仅协议 4/设备 API 3，引用同插件的精确 device/read 能力及采样贡献，采样为空输入产物/无输出授权。SDK 声明版本与浏览器 HostContext 版本无关。新字段使 Rust 完整构造点需要补齐，但旧清单与旧样本 JSON 保持兼容。

公开目标、样本和 FPS 窗口仍在根模块，既有帧、字段及 FPS 口径不变。最小冻结合同见 [性能采样迁出裁定](../../../docs/性能采样迁出最小实施裁定.md)。纯回归覆盖旧省略/默认、API 2 精确引用、版本/类型/未知/重复及 Rust 字面量边界；由主代理执行 Cargo 后报告真实结果，本角色不运行门禁。
