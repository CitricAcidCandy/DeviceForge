# MCP 插件开发指南

## 契约与职责

AI 开发 DeviceForge 插件前，调用只读工具 `deviceforge.get_plugin_development_guide`。工具无需加载任何业务插件，不提交任务，也不读取运行机器上的源码目录。初始化说明提供发现提示；客户端是否调用仍由其自身决定。

请求参数：

```json
{"target":"fullstack","topic":"overview"}
```

`target` 必填，为 `frontend`、`backend` 或 `fullstack`。`topic` 可省略，默认 `overview`；支持 `overview`、`manifest`、`sdk`、`lifecycle`、`examples`、`packaging`、`validation`。未知字段、未知枚举、空值和类型错误均拒绝。

响应包含指南版本、当前宿主版本、前端 SDK 版本、后端任务与交互协议版本、请求主题和 `documents`。每份文档包含 `target/topic/source/content`；`source` 是源码归属说明，实际知识在 `content` 中，远端 AI 不需要访问该路径。`fullstack` 返回同一主题的两端文档。

## 编译与维护

前端知识源为 `frontend/docs/guides/plugin-development/`，后端知识源为 `backend/docs/guides/plugin-development/`，分别维护七个主题。server 的 `plugin_guide` 模块用 `include_str!` 将内容嵌入可执行文件；复制单个宿主程序或通过现有 CLI 运行包分发时，指南随二进制交付，不需要增加运行时文件路径配置。

`mcp.rs` 只路由调用和提供初始化引导，`mcp_tools.rs` 负责目录组合，独立指南模块负责参数、文档选择与响应。响应沿既有 MCP 日志元数据关联，不将指南当作异步任务。

修改公开 SDK、协议或示例后应同步对应主题，并重新编译宿主。文档修改不会热更新已运行的旧二进制；`host_version` 是软件版本，不能独立证明两个开发构建的内容相同。指南中的 `guide_version` 表示知识接口版本。

## 验证入口

- `cargo test -p apk-server --test plugin_guide`：工具发现、初始化引导、21 种目标与主题组合、参数拒绝、日志和无任务副作用。
- `node --test scripts/tests/plugin-guide.test.mjs`（工程根目录）：执行指南完整示例并检查清单与入口。
- `node scripts/plugin-guide-smoke.mjs`（backend 目录）：将当前 debug 宿主复制到临时空目录，验证真实 MCP 返回嵌入指南；报告保留在根 artifacts。可用 `--release` 验证已构建的 release 宿主。

具体通过结果记录于根 `todo.md`；命令存在不表示已经执行。该功能不扩展 MCP Resources、Prompts、在线安装或设备调用权限。
