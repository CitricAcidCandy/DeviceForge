# Android 安装包领域端口

作用：描述 APK / AAB 清单、APK 签名验证和 APKS 条目提取结果，供业务用例与不同工具适配器共用。适用于 HTTP、MCP 和后续插件贡献中的安装包分析。

快速开始：实现 PackageAnalyzer，再注入 application::packages::PackageOperations；领域层不依赖工具命令或文件路径。

API：manifest(id, module, cancel) 返回 PackageManifest；signature(id, cancel) 返回 PackageSignature；extract_apk(id, entry, cancel) 返回 ExtractedApk。三个方法只接受产物 ID，工具与临时文件管理属于基础设施层。所有返回类型支持序列化和 JSON Schema 生成。

增加默认兼容入口：manifest_with_context(id, module, cancel, context)、signature_with_context(id, cancel, context)、extract_apk_with_context(id, entry, cancel, context)，返回类型与对应旧方法一致；末参数为公开 ExecutionContext。默认实现直接委托旧方法，旧仅实现者无需新增必需方法。context 只含标准库单调时钟的可选绝对截止点，领域端口不引用包核心、不创建工作池，也不刷新预算。

支持全阶段期限的适配器必须覆盖三个新入口，把 Some(D) 原样用于输入副本、工具、同步核心和发布；None 保留其原期限约定。兼容默认法不强制旧底层实施全阶段截止点，不应将旧仅实现者的正常调用视为此保证。

has_unresolved_resources() 默认 false，供无未确认资源的旧实现保持兼容；有阻塞 worker、工具清理观测的适配器覆盖并报告真实状态。它用于向执行器传播清理资格，不能以 Future 丢弃或临时目录删除代替实际工作退出确认。

版本号、SDK 与应用名称保留工具输出的字符串值，允许资源引用或预览 SDK 标识；permissions 去重，xml 保留原始解码清单。签名模型包含验证通过标志、方案、签名者编号和证书 SHA-256。ExtractedApk 保留来源 ID、精确条目名及新产物元数据。
