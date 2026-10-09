# AAB 构建应用操作
BundleOperations 注册 android.package.build_apks，以领域类型生成 JSON Schema，HTTP 与 MCP 共用任务层。执行时再次反序列化和验证，再交给 BundleBuilder；未知操作、取消和非法输入不会调用端口。测试见 tests/bundles.rs。