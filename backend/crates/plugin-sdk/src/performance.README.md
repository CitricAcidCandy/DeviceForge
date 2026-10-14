# 性能声明纯契约

`performance.rs` 提供 `PerformanceAccess`、`PerformanceDeviceCapability` 与纯 `validate()`，根模块继续导出原 `PerformanceAccess` 名称。SDK 不查注册表、编译 schema、读取时钟、启动工具或持有会话。

API 1 省略 `api_version` 时默认 1，序列化值 1 时省略，保留旧声明外形；`fps` 仍默认 false。API 1 不能绑定设备能力。API 2 必须显式携带 `{id,version}` 引用，引用严格拒绝未知字段、标识最多 100 字节且遵守既有 ASCII 标识资格、版本为非零 u32。未知版本、错误类型、重复字段或冲突绑定反序列化失败；Rust 字面量须调用 `validate()`。

宿主另行校验：API 1 仅协议 2、沿用全插件禁产物规则；API 2 仅协议 4/设备 API 3，引用同插件的精确 device/read 能力及采样贡献，采样为空输入产物/无输出授权。SDK 声明版本与浏览器 HostContext 版本无关。新字段使 Rust 完整构造点需要补齐，但旧清单与旧样本 JSON 保持兼容。

公开目标、样本和 FPS 窗口仍在根模块，既有帧、字段及 FPS 口径不变。最小冻结合同见 [性能采样迁出裁定](../../../docs/implementation/性能采样迁出最小实施裁定.md)。纯回归覆盖旧省略/默认、API 2 精确引用、版本/类型/未知/重复及 Rust 字面量边界；由主代理执行 Cargo 后报告真实结果，本角色不运行门禁。


## 设备观测第一版

`performance/observation.rs` 定义可选设备电气与温度观测。`PerformanceSample.device_observation` 缺省省略，旧 JSON 保持兼容；来源声明新增默认 false 的 `device_observation`，未声明不能返回观测。SDK 与宿主领域类型独立，适配器显式映射。

容器限定 `api_version=1`、`scope=device`，设备编号保留 UTF-8 原文且须与会话目标一致。各成员记录宿主 Unix 毫秒观测时间，最多落后样本 10 秒；电压 µV、电流 µA、温度 °C，来源及访问权限必须明确。净电池功率单位 mW，正充电、负放电，仅未知极性省略；它是整机电池侧观测，不是游戏耗电。

纯校验覆盖版本、归属、时效、长度、单位范围、充放电矛盾、非有限温度、HAL 类型和重复传感器。BCL 电压、电流及百分比类型不作温度，传感器名称拒绝控制符与替换字符。完整合同见[Android游戏指标Rust采集实施](../../../docs/implementation/Android游戏指标Rust采集实施.md)。

## 部分缺测契约

performance/metric_missing.rs提供纯MetricMissing、UnavailableMetric与原因枚举。系统计数/核数和PSS可空，必须与真实缺测原因精确对应，不以零代替不可读值；来源限1–80字节ASCII稳定标识。缺测对象版本1，至少一项cpu/memory存在；其它项可省略或null，空容器拒绝。

PerformanceAccess.partial_metrics默认false，只有API2设备型性能来源可显式true。旧完整数字样本保持可读；取消、期限、进程身份与工具清理错误仍由原协议和执行层处理，不属于此纯模块。
