# 基础设施适配器

作用：提供受控子进程、ADB / HDC 工具、独立进程插件和 SQLite 任务存储。适用于部署主机的工具执行与持久化。
快速开始：`cargo test -p apk-infrastructure`；部署前配置工具路径。
API：`process::run` 参数为入口、argv、可选输入、超时与取消令牌；`devices::DeviceTools` 实现领域执行端口；`plugins::load` 读取管理员部署的清单；`store::SqliteStore::open` 打开任务库。
生产装配使用 plugin_catalog::FilePluginCatalog 的异步 open/initial/load；旧 plugins::load 仅保留兼容。
插件进程环境不继承 API 令牌；输出超限、退出失败、超时或取消均失败收敛。

## 固定部署目录

plugin_catalog.rs 实现领域 PluginCatalog，输入为固定部署根及产物端口，输出为已校验的进程贡献。最多 2 个阻塞文件工作，日志上下文传播至工作线程；清单最多 64 KiB，双重限制元数据和实际读取字节。目录名须等于插件 ID，目录/清单拒绝链接和越界位置；初始扫描最多 1024 条目录条目、256 个插件，跳过隐藏暂存区并按 ID 排序。

目录读取不决定注册或卸载状态，不接受请求指定的路径。tests/plugin_catalog.rs 验证排序/暂存、非法与缺失 ID、错配/损坏/超大清单、扫描上限、目录及清单符号链接。部署插件为管理员可信代码，校验不构成系统沙箱。

设备产物操作由 device_artifacts::DeviceArtifactActions 实现，注入 ArtifactStore 与部署工具路径。process::run_text 同时返回标准输出 / 错误供成功判定，process::run_to_file 为截图提供有界流式写入；具体参数与限制见 src/device_artifacts/README.md。

安装包分析由 package_tools::AndroidPackageTools 实现 PackageAnalyzer 领域端口；artifact_files 统一安装与分析的临时产物流式复制和 SHA-256 校验。各模块 README 描述参数、资源上限与测试。

reverse::AndroidReverse 提供受控反编译和 SDK 路径检测，输出监测、打包与扫描分文件实现；端口和操作贡献位于 domain / application 的 reverse 模块。

plugins::load_with_artifacts 为协议版本 2 插件注入产物端口，plugin_artifacts 实现能力声明检查、临时输入与输出发布；版本 1 的 load / ProcessPlugin::new 保持可用。

device_input::AndroidInput 提供类型化 Android 输入，设备端引用与字面量 %s 分片、同设备串行、30 秒总期限和诊断判定位于 src/device_input，模块文档说明部分输入与非幂等性。

performance::AndroidPerformance 与 performance::store::SqlitePerformance 提供设备性能探针和独立会话数据库；端口位于 domain，生命周期及贡献位于 application。详见 src/performance/README.md。

performance_plugin::PluginPerformance 将协议 2 采样操作适配到领域 PerformanceProbe，验证模式、计数、时间与 FPS 窗口；不要求第三方插件引用宿主内部类型。

bundles::AndroidBundles 提供 AAB 双模式构建，显式部署签名、独占工具环境、总期限、输出监测及 APKS CRC / 布局校验。操作与端口位于 application / domain 的 bundles 模块，详见 src/bundles/README.md。

splits::AndroidSplits 提供 APKS 规格提取和设备匹配安装，复用外层 APKS 校验、受控工具环境及产物端口；输出打包和监测位于 src/splits/packing.rs，模块文档说明同设备安装锁、总期限及真实包边界。
