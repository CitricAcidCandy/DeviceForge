# 分包应用操作
SplitOperations 注册 android.package.extract_splits 与 android.app.install_apks，复用通用 HTTP / MCP 任务层。以领域类型生成模式并增加规格列表 uniqueItems 约束，执行时再次验证，不把任意工具参数交给端口。行为测试见 tests/splits.rs。