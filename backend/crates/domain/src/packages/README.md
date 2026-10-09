# Android 安装包领域端口

作用：描述 APK / AAB 清单、APK 签名验证和 APKS 条目提取结果，供业务用例与不同工具适配器共用。适用于 HTTP、MCP 和后续插件贡献中的安装包分析。

快速开始：实现 PackageAnalyzer，再注入 application::packages::PackageOperations；领域层不依赖工具命令或文件路径。

API：manifest(id, module, cancel) 返回 PackageManifest；signature(id, cancel) 返回 PackageSignature；extract_apk(id, entry, cancel) 返回 ExtractedApk。三个方法只接受产物 ID，工具与临时文件管理属于基础设施层。所有返回类型支持序列化和 JSON Schema 生成。

版本号、SDK 与应用名称保留工具输出的字符串值，允许资源引用或预览 SDK 标识；permissions 去重，xml 保留原始解码清单。签名模型包含验证通过标志、方案、签名者编号和证书 SHA-256。ExtractedApk 保留来源 ID、精确条目名及新产物元数据。
