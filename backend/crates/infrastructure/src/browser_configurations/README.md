# 浏览器插件用户配置存储

输入为装配传入的用户配置 `browser` 根，输出为领域 `BrowserConfigurationStore`。`mod.rs` 负责有界工作接纳、互斥与CAS，`storage.rs` 独占目录边界、文件锁、读取上限和同目录原子替换。模块不读取环境、不发现插件、不解析配置模式，也不操作浏览器本地存储。

记录完整保留版本、JSON对象原值、修订、已应用修订和历史敏感路径。每文件最多256 KiB，最多两个阻塞工作，跨进程独占用户根。请求取消不提前释放文件工作的许可。损坏、超限或链接文件不被默认值覆盖。

定点入口为 `cargo test -p apk-infrastructure --lib browser_configurations -j 1`。公开契约和迁移调用方边界见 [浏览器插件用户配置](../../../../docs/contracts/浏览器插件用户配置.md)，实际验收见 [本轮记录](../../../../docs/verification/插件用户目录配置验收-20261022.md)。
