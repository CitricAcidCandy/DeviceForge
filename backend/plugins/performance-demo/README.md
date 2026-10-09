# 性能插件公开协议示例

根目录 `npm run pack:plugins -- performance_demo` 生成当前平台 release 便携 tgz，使用 npx 安装后重启加载；见 ../../docs/原生插件分发.md。绑定为会话探针仍需部署 APK_PERFORMANCE_PLUGIN=performance_demo。

本示例只演示性能采样协议，所有 CPU / 内存 / FPS 值为合成数据，帧来源明确为 synthetic_demo。它不访问 Android 设备，也不用于真实性能验收。生产依赖只有公开 plugin-sdk 和 serde_json，不引用宿主内部领域、应用或基础设施。

构建：cargo build -p deviceforge-performance-demo-plugin。复制 manifest.example.json 到管理员 APK_PLUGIN_DIR 下的独立目录并填写实际绝对入口路径；配置 APK_PERFORMANCE_PLUGIN=performance_demo 后重启服务。同一个 android.performance.start / samples / pause / resume / stop API 会使用插件采样器。

协议 2 的 sample 操作接收 device_id / package，返回 PerformanceSample：CPU 累计计数、主进程身份、PSS / RSS 与可选帧窗口。FPS 60 来自 60 帧 / 1000 毫秒。响应不生成产物，宿主环境不应含 APK_API_TOKEN。

--bad-window / --bad-source / --bad-frames / --bad-pid / --stale / --future / --unknown / --no-fps / --error / --slow 是协议测试用的部署参数，HTTP 请求不能设置这些参数。无参数才是常规合成演示。

验证：cargo test -p deviceforge-performance-demo-plugin，覆盖真实进程、样本持久化和 FPS 口径、清单 / 模式 / 类型 / 时间 / 窗口错误、取消与 10 秒超时；node scripts/runtime-smoke.mjs --performance-plugin 验证真实服务的会话控制和 MCP。

真实采样插件应读取设备真实计数，并提供准确的观测窗口与来源；缺少观测时省略 frame_window，不能用此示例合成值替代真机数据。
