# MCP 插件开发指南

## 契约与职责

AI 开发 DeviceForge 插件前，调用只读工具 `deviceforge.get_plugin_development_guide`。工具无需加载任何业务插件，不提交任务，也不读取运行机器上的源码目录。初始化说明提供发现提示；客户端是否调用仍由其自身决定。

请求参数：

```json
{"target":"fullstack","topic":"overview"}
```

`target` 必填，为 `frontend`、`backend` 或 `fullstack`。`topic` 可省略，默认 `overview`；支持 `overview`、`manifest`、`sdk`、`lifecycle`、`examples`、`packaging`、`validation`。未知字段、未知枚举、空值和类型错误均拒绝。

响应包含指南版本、当前宿主版本、前端 SDK 版本、后端任务与交互协议版本、完整发布格式及宿主 API 版本、请求主题和 `documents`。每份文档包含 `target/topic/source/content`；`source` 是源码归属说明，实际知识在 `content` 中，远端 AI 不需要访问该路径。`fullstack` 返回同一主题的两端文档。当前 `guide_version=2`，参数与七主题保持兼容，新增 `release_format_versions:[1]` 与 `release_host_api_versions:[2]`。

## 编译与维护

前端知识源为 `frontend/docs/guides/plugin-development/`，后端知识源为 `backend/docs/guides/plugin-development/`，分别维护七个主题。server 的 `plugin_guide` 模块用 `include_str!` 将内容嵌入可执行文件；复制单个宿主程序或通过现有 CLI 运行包分发时，指南随二进制交付，不需要增加运行时文件路径配置。

`mcp.rs` 只路由调用和提供初始化引导，`mcp_tools.rs` 负责目录组合，独立指南模块负责参数、文档选择与响应。响应沿既有 MCP 日志元数据关联，不将指南当作异步任务。

修改公开 SDK、协议或示例后应同步对应主题，并重新编译宿主。文档修改不会热更新已运行的旧二进制；`host_version` 是软件版本，不能独立证明两个开发构建的内容相同。指南中的 `guide_version` 表示知识接口版本。

## 第二版知识覆盖

十四篇已逐项按统一发布核对：overview 说明完整功能与用户根；manifest 说明外层 release.json、两类独立组件、工具 entries/bindings 与 requirements/any_of；sdk 说明 DEVICEFORGE_PLUGIN_RESOURCES、managed_resources、有效快照和原值优先；lifecycle 区分发布持久启用意图、当前实例、expected_revision、configuration_required 与旧管理入口；examples 保留原可运行组件示例，补成套结构模板；packaging 说明能力探测、在线资源/catalog 顺序、离线完整 ZIP 与旧入口兼容；validation 列出失败和实际交付证据边界。

`fullstack_workflow` 不再引导配套功能分别安装，而是先定义通信，再以 `format_version:1,host_api_version:2` 组合底层服务器包和 SDK v2 浏览器包及实际工具，交由统一安装用例。托管文件归宿主用户根，配置不保存在 npx 缓存；工具路径覆盖只影响有效快照，用户高级显式路径优先，升级/卸载保留两端配置。

资源服务器发布能力固定由 `GET /api/v1/capabilities` 声明版本、2 GiB 单资源上限、catalog 最后提交与不可覆盖版本。网页上传前探测，缺能力时提示升级且不写资源。沿既有资源与 catalog 协议完成发布，不新增服务器 ZIP 解包 API。知识更新、路由测试与构建不能证明网页发布、真实设备、正式分发或市场远端已验收。

## 验证入口

- `cargo test -p apk-server --test plugin_guide`：工具发现与四项只读标注、三目标缺省主题、21 种组合的精确文档数量与固定来源、参数拒绝、日志和无任务副作用。
- `node --test scripts/tests/plugin-guide.test.mjs`（工程根目录）：核对十四篇固定嵌入来源、UTF-8、读取预算与第二版知识；执行两个完整组件示例，并用真实 TGZ/ZIP 校验成套模板身份、摘要、大小及离线闭包，确认在线路径转换后重算修订。此检查不发布资源、不安装宿主插件。
- `node scripts/plugin-guide-smoke.mjs`（backend 目录）：将当前 debug 宿主复制到临时空目录，显式隔离 `DEVICEFORGE_USER_DIR`、业务数据及两类插件部署目录，验证真实 MCP 返回嵌入指南，不读写真实用户根；报告保留在根 artifacts。可用 `--release` 验证已构建的 release 宿主。

2026-10-23 本轮有限收口：Node 定点测试 4/4 通过，宿主 smoke 仅语法检查通过。生产代码与十四篇嵌入文档未修改；Rust 路由测试新增断言尚未执行，Cargo、生成器、构建及真实宿主 MCP 复验交由主代理统一安排，不能将 Node 归档验证计为这些门禁通过。根 todo 与集成交接记录也由主代理更新。

具体通过结果记录于根 `todo.md`；命令存在不表示已经执行。该功能不扩展 MCP Resources、Prompts、在线安装或设备调用权限。
