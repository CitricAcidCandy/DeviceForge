# 根工程打包与交付工具

这里仅保存跨端交付工具，各端业务与约束仍放各自目录。

- prepare-runtime.mjs：编译当前平台 Rust 后端/离线插件校验器，构建前端，记录程序摘要并原子生成 runtime。默认 release，--debug 用于快速开发验收。
- verify-package.mjs：npm prepack 门禁，检查版本、平台入口、摘要与静态首页。它不会下载依赖或自动编译。
- cli-smoke.mjs 与 cli-smoke-fixture.mjs：真实 tgz/npx 安装与局域网运行验证；仅操作本次临时目录和进程，不写源项目。
- native-plugin-plan.mjs：从 Cargo 与现有插件清单派生便携平台包、校对版本和选择；不复制宿主业务规则。
- native-plugin-package.mjs 与 pack-native-plugins.mjs：构建原生 release 插件、调用 Rust 安装门禁并生成 tgz；`npm run pack:plugins` 可按插件 ID 选择。
- cli-smoke-native.mjs：通过真实 npx 安装四个原生包，再经 HTTP/MCP 验证回显、产物复制、MessagePack 与合成采样；与 Node 依赖安装验证共用启动器。

正式打包：npm run pack:cli。基础门禁：npm test；完整分发验证：npm run smoke:cli。两端还须各自执行 AGENTS.md 指定的检查，不以根 CLI 测试替代后端与前端验收。

原生插件包格式、版本和当前平台限制见 backend/docs/原生插件分发.md。插件编写只维护原有 Cargo 元数据及公开清单，便携 npm 描述由构建派生。
## 运行中安装与管理

cli-smoke-lifecycle.mjs 在真实 npx 服务启动后安装 Node 依赖插件，验证安装脚本禁用、HTTP 加载及任务执行、独立 MCP 卸载/重载、新代际和历史任务保留，由 cli-smoke.mjs 统一编排。它只验证本机当前平台包，不等于 npm registry 发布或设备层热拔插验收。
