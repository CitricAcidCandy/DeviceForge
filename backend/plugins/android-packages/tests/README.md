# 安卓包插件独立原帧验收

本目录只消费已构建的 `deviceforge-android-packages-plugin` 可执行文件；测试手写 JSON Request、Ready、Start、取消帧，不借助宿主 `ProcessPlugin`、SDK 序列化、生产配置类型或公共核心构造期望。原帧 `operation` 使用七个短名；外部贡献及别名 target 的完整 ID 不属于进程 Request，另有完整 ID 的精确拒绝用例。

`protocol.rs` 共 43 项：正常业务 10 项、拒绝 22 项、期限与取消 11 项。部分测试逐个创建独立目录验证多行固定场景，数量不等于真实平台或设备数。

## 固定样本与正向断言

- manifest 的 APK、AAB 默认 base 与显式模块：完整原 DTO、字符串版本号、可空字段、XML 原文、独立 argv 与私有输入副本。
- signature：完整原报告、签名方案、摘要以及未提供 DN 的显式 null。
- extract_apk、build_apks 两种模式：唯一公开输出名、原文件字节与 SHA256；签名材料作为独立 argv，长期文件保持原字节。
- decode：实际最终 ZIP 三成员的原字节、CRC、成员数量和解包长度。核成员而非 ZIP 头部时间戳。
- scan_sdks：规则原顺序、缺省/显式 null 类名、命中与不命中、实际路径证据，无工具进程。
- extract_splits：工具收到 camelCase 规格、公开结果保持 snake_case，两个 APK 的实际最终归档字节与唯一输出名。

样本是独立手工 Stored ZIP；工具为本目录 std-only Rust 源，测试执行时经 `OnceLock` 调用 rustc 编译一次，每例复制到带空格、中文和特殊字符的目录。它观察原 argv、私有输入原字节、输出路径和 ready 门闩，随后等待 release；没有 shell、真实 Java、Android 工具或真机。结构正向不能写成 APK 可安装或签名真实可信。

## 拒绝与收口

拒绝精确匹配已冻结 `error.rs` 的 Display 和配置、session、业务静态错误文案：严格 JSON/64 KiB/绝对配置路径、入口类型和依赖、唯一产物及 field/ID、64 MiB 声明上限、摘要格式/实长/私有复制 SHA、普通文件与输出授权、业务未知字段、UUID、APK 模块、精确 entry、SDK 规则、设备规格、缺成员/重名/选中 CRC、非零工具及非 UTF-8。三个 XML 命名空间实体回归走实际 manifest 工具与公开 DTO。

注意，全目录去重先于 `select_exact`，该插件的重名样本应为 `输入无效：ZIP 包含重复条目`，不能用公共核心的另一错误映射替代。预拒要求零工具、零宿主输出；运行失败要求没有成功摘要/输出声明，且私有目录已清空、宿主输入和长期签名文件未改。

Start 为零或等待 Ready 后延迟再发一纳秒，要求到期优先于坏配置、零工具。坏 Start 的 ID、版本、未知字段要求进程 exit1、精确 stderr、无业务 Response。重复 Start 是无效控制帧，不续期。

运行取消在真实工具 ready 后持有本次 PID 观察对象，再发送取消；覆盖 manifest、build、decode、splits。另有本地短 D、timeout 控制 reason 和 EOF。每次分别断言精确错误、`cleanup=complete`、插件正常 exit0、同工具 PID 实际退出、零发布及私有目录删除。Windows 持有同 PID 系统等待句柄；Unix 等待本次 PID 消失。工具的退出意图标记不能替代 OS 退出证据，直接 PID 退出不能证明派生树或外部资源完全清理。

## 执行与证据边界

本批作者未运行格式化、编译、测试或服务；由主代理在生产冻结并重建后统一执行 `cargo test -p deviceforge-android-packages-plugin --test protocol`，再接完整门禁。无新增 Cargo 依赖。

所有墙钟看门狗只防挂起，不提供性能或精确计时结论。原帧测试不能暂停另一个真实插件进程的 Tokio 时钟；精确 C0、计时器刻度、晚结果拒绝及 failed 保留仍关联公共 runtime 的受控测试，本组不冒称重复证明。八秒本地 D 仅让真实工具进入 hold 再收口，不等实际 120 秒工具短限额。

每例记录插件 PID、Request/Start/control 原帧、真实 stdout、stderr 和插件退出状态。失败保留本次临时目录；测试兜底强杀单独写 `test-fallback-kill.txt`，绝不计作业务清理通过。成功目录按 TempDir 生命周期回收。

尚未覆盖确定性的 `CleanupFailed` 触发、实际平台工具、HTTP/MCP 发布与下载、旧入口同 Job 投影、真实 npx 原 TGZ 身份、进程派生树、真机及性能会话。这些需要另外分配服务/脚本写集与串行执行权限，不能从此原帧组扩大完成范围。
