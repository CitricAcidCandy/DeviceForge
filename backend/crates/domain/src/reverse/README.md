# APK 反编译与 SDK 检测领域端口

作用：定义 PackageReverse 端口，支持 APK 反编译产物与基于包路径的 SDK 检测。适用于 HTTP、MCP 和可替换工具适配器。

快速开始：实现 PackageReverse 并注入 application::reverse::ReverseOperations；领域层不接收本机路径或工具参数。

API：decode(id, cancel) 返回 DecodedPackage，包括来源 ID、ZIP 产物、文件数量与文件总字节；scan_sdks(id, rules, cancel) 返回 SdkScan。SdkRule 指定 name、点分包路径 package_path 和可选 class_name。SdkFinding 分别报告 package_found、class_found 和最多十条路径证据。

未提供 class_name 时 class_found 为 null；提供后明确返回 true / false。包目录证据不代表 SDK 已加载、版本确认或代码安全检查。
