# 设备领域模型

此模块负责宿主设备引用、提供者代际、声明能力和观测目录，不依赖公开插件 SDK 的传输消息、ADB/HDC 或 HTTP。DeviceRef 以提供者/代际/本地 ID 区分设备，DeviceDirectory 保留明确观测时间和共享发现任务 ID。

基础设施对公开 SDK 做一次命名映射；应用层负责目录观测、能力解析、注册快照准入和写操作互斥。设备状态和能力可用性分别表达，不能以平台名称推断实现或功能支持。

设备声明支持 API 1/2/3。API 2/3 的能力可声明 execution_timeout_ms，省略或 null 默认 30000 毫秒，显式值为 1–120000；API 1 不允许非空预算。该预算由注册规则验证，用例从准入起确定单一截止点，业务输入不能覆盖；发现自身仍统一 30000 毫秒，不套能力预算。

ProvidedDevice 的可选 raw_state 保存插件原始状态，缺失或 null 归 None，None 序列化省略。rules::devices 在同一份观测内校验：API 1/2 拒绝非 null 原文；API 3 接受 None 或非空、非全空白、最多 100 UTF-8 字节且不含 Unicode 控制字符的字符串。原文只校验、不规范化，合法未知状态保留；任一坏设备使整份观测失败。基础设施将消息或规则错误映射为 Dependency，不发布部分有效设备。

归一化 DeviceState 和已声明能力继续决定动作准入，raw_state 不放行 recovery/sideload/bootloader 等特殊模式。身份、代际和目录发布仍属于应用层。发现贡献的模式根类型必须是 object，并且实际接受空对象；设备声明版本与任务传输协议、HTTP、浏览器 SDK 和绑定格式独立。

raw_state_tests.rs 是原文版本、UTF-8 字节边界、控制字符和序列化的纯回归。本次模型/映射接入不代表统一发现三入口、绑定格式 2、平台迁出、常驻连接或真机已完成；后续集成与验收由主代理统一执行。

领域执行上下文 ExecutionContext 位于 ../execution.rs，只携带可选标准库 Instant。Executor::execute_with_context 默认委托已有 execute，独立插件传输覆盖该入口；领域不依赖 Tokio 时钟、HTTP 或外部进程。
