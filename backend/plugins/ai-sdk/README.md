# AI SDK 插件规格草案

本目录包含 Rust 插件、固定版本官方 Node SDK worker、私有 exec 代理、协议 4/5 入口和公开流规范化实现。完整实施依据为[AI SDK桥接实施裁定](../../docs/implementation/AI%20SDK桥接实施裁定.md)，不能把窄编译、模拟 CLI 或单个平台监督通过计成真实模型和完整进程树迁移完成。

目标为独立服务器端官方SDK插件：普通任务协议4，实时会话协议5，提供新线程、恢复轮次、流事件及旧测试助手最多四轮编排。SDK线程归属与既有CLI线程严格分开，原InvocationContext总业务期限贯穿全部步骤；不自动切换提供者重放提示词。

桥接采用固定官方SDK、包内Node worker与私有exec代理，真实CLI由Rust协调器通过公开tool-process直接持有。私有IPC有身份握手、帧/队列/输出限额与原截止点；业务取消、清理资格及持久线程uncertain分别记录。Node/代理真实退出、三平台原生强杀监督、锁与阻塞worker实际释放均属于实施范围。

## 部署配置草案

[配置模板](ai-sdk.config.example.json)只展示字段形状。路径均为部署示例，不表示文件已存在；环境为空，不包含认证材料或固定模型。初始资格档案固定SDK/CLI 0.162.1及Node 24.14.0，其他版本须建立新档案，不按版本号相近自动接受。

| 字段 | 含义 |
| --- | --- |
| format_version、profile | 草案格式与固定SDK/Node/CLI档案。 |
| node_executable、node_version | 部署者明确的绝对Node入口及必须实际核对的版本。 |
| sdk_entry、sdk_version | 托管官方SDK的绝对模块入口与实际包版本；不接受浏览器动态模块。 |
| cli_executable、cli_version | 部署者明确的真实CLI入口与实际平台版本。 |
| projects | 项目ID到规范服务器项目目录的部署映射；业务调用仅提交ID。 |
| state_root | SDK专用资格与跨进程锁目录。 |
| codex_home | SDK提供者历史/配置专用目录，不能混用既有CLI历史。 |
| environment | 仅传给真实CLI的部署环境；字段和值不进入日志/结果。 |
| thread_options | 固定SDK档案允许的部署选项，空对象沿提供者默认；生产须按档案逐项白名单核对。 |

worker、代理与原生监督入口固定在插件包内，不允许配置替换。实际包布局以当前插件 exe 所在目录为根，包含 `ai-sdk.config.json` 与 `worker/dist/{index,probe,protocol,sdk,shutdown}.js`，不依赖宿主工作目录。默认清单 `args: []` 读取旁置配置；管理员也可用清单 `args: ["--config", "绝对配置路径"]` 指定部署配置，worker 与代理仍固定。`DF_SDK_CONFIG` 和 `DF_SDK_WORKER_ENTRY` 不再作为入口，浏览器请求不包含程序或配置路径。

原生便携包若使用 `bin/deviceforge-ai-sdk-plugin.exe`，则模板、实际配置和 `bin/worker/dist` 均与 exe 旁置。根 `package-assets.json` 声明五个构建 JS 和两份 worker 包元数据的通用静态成员映射，不复制依赖目录、实际配置或凭据。配置模板不能直接视为已准备配置；缺配置、缺任一固定 JS、文件类型错误或超限返回明确未准备错误。部署规则与职责见[固定包入口](src/deployment/README.md)。运行时准备复用公开tool-supply的ai-sdk功能映射；托管准备、模块加载、模拟CLI、真实SDK、真实模型、HTTP/MCP、浏览器、正式包/npx及各目标OS分别取得证据。SDK插件本身不在业务调用中下载包、执行npm install或重授业务期限。

## 运行资格查询

`runtime.status` 在原调用期限内并行执行有界探测：实际 Node `--version`、实际 CLI `--version` 与包内 `probe.js`。每个探测最多消耗五秒业务时间，停止与收口继续使用固定清理窗口。版本结果只保留严格格式的版本字段，不返回原始输出或部署环境；SDK 加载同时核对官方模块内容摘要、包名、包版本和构造入口，不产生模型请求。

Node、CLI 与 SDK 探测均通过公开 `OwnedTree` 持有。SDK 探测还须完成私有监督的实际进程身份握手、成功退出候选、内部完整范围收口以及外层监督范围的实际退出。本次全部成立才将 `process_scope_qualified` 置为真；该字段只表示当前平台本次探测资格，不表示 Windows、Linux、macOS 故障与强杀矩阵都已验收。当前公共工具库未为 Linux/macOS 开放 `OwnedTree`，这些平台保持不可用，不回退为直接子进程清理。

`model_verified` 来自当前部署配置摘要对应的历史完整 SDK 轮次。协调器先核对真实 CLI、SDK 事件、私有监督、公开进程范围、线程提交和实际资源结束，再在公开成功终态前原子提交模型资格记录。配置文字、版本输出和 SDK 加载探测均不能单独产生此资格；模拟 CLI 测试产生的隔离资格文件也不能作为真实部署模型联调证据。普通任务、助手和状态探测均保留清理失败结果，不用业务错误包装成资源已释放。

## 当前边界与接续

前一批 worker TypeScript 构建与真实官方 SDK worker 的模拟 CLI 回归已通过，不转计为本批真实模型证据。协调器已接入普通任务、助手四轮计划、协议 5 实时会话、线程资格和有限清理窗口。本批实际版本与 SDK 加载探测、公开 `OwnedTree` 接线、模型资格提交及清理结果传递已落盘；当前 Windows SDK 插件 `cargo check`、18 项完整 crate 回归、全目标 Clippy、定点格式、27 模块架构门禁及 debug 插件构建通过。首轮四处私有分支风格失败保留，修后通过；Linux/macOS 源码未在目标平台编译或运行。完整三平台监督、真实 CLI/模型、HTTP/MCP、浏览器宿主、正式安装包与真实设备环境仍分别验收。

固定旁置部署入口与七项静态打包映射已完成本批验证：当前 Windows SDK 插件 `cargo check`、22 项完整 crate 回归、全目标 Clippy、定点格式检查及 debug 插件构建通过，包含四项部署配置、固定成员、文件类型与体积限制回归；七项声明源成员检查通过。上述结果只覆盖插件所属构建与回归，正式安装、不同服务工作目录、配置未准备和真实服务路径继续由独立冻结二进制并行验收。
