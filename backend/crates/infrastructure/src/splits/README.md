# bundletool 分包适配器
AndroidSplits 复用经过大小 / SHA-256 验证的临时产物复制与 APKS 外层校验，使用管理员 bundletool 做真实匹配语义。提取输出检查和流式 ZIP 打包位于 packing.rs，安装使用显式设备 / ADB 路径，同实例 APKS 安装按设备串行；不覆盖其他设备写操作。

extract.rs 编排提取，packing.rs 通过独立 android-package-core 的 Splits 树与 Stored ZIP 规则扫描和打包，早拒非 APK，最终区分空输出与坏 APK。extract_with_context 的 Some(D) 包括副本、APKS 校验、规格、工具、监测、打包和发布；None 保留提取整体 120 秒。with_capacity 与其他包适配器共享四槽实际同步容量，风险仍独立归本实例。

工具与在飞树监测共享一次两秒并发清理点，CleanupFailed 优先返回并禁止打包 / 发布。工具 Future 丢弃标记持久保留；后台同步闭包持有许可和目录至真实退出，不能用外层超时推断资源已清理。安装继续旧请求、DTO、设备锁与调用链，其 120 秒预算和完整清理仍独立验收；同实例 extract 的持久风险会影响后续 install 的用例收口诊断，不宣称安装全行为不变。失败诊断使用固定说明，工具环境剥离凭据。输出目录 64 MiB / 1000 条目 / 128 层，最终 ZIP 64 MiB；轮询不是硬磁盘配额。

cargo test -p apk-infrastructure splits 验证独立模拟工具、规格匹配、安装、错误输出、体积、取消、期限与设备锁。真实包 / 真机、高级匹配维度、全局设备互斥及完整进程树回收仍待验收或实现。完整契约见 backend/docs/APKS设备匹配接口.md。
