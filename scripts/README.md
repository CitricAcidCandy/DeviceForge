# 根工程打包与交付工具

这里仅保存跨端交付工具，各端业务与约束仍放各自目录。

- prepare-runtime.mjs：编译当前平台 Rust 后端/离线插件校验器，构建前端，记录程序摘要并原子生成 runtime。默认 release，--debug 用于快速开发验收。
- verify-package.mjs：npm prepack 门禁，检查版本、平台入口、摘要与静态首页。它不会下载依赖或自动编译。
- cli-smoke.mjs 与 cli-smoke-fixture.mjs：真实 tgz/npx 安装与局域网运行验证；仅操作本次临时目录和进程，不写源项目。
- native-plugin-plan.mjs：从 Cargo 与现有插件清单派生便携平台包、校对版本和选择；不复制宿主业务规则。
- native-plugin-package.mjs 与 pack-native-plugins.mjs：构建原生 release 插件、调用 Rust 安装门禁并生成 tgz；`npm run pack:plugins` 可按插件 ID 选择。
- cli-smoke-native.mjs：通过真实 npx 安装五个原生包（echo、artifact_copy、msgpack、performance_demo、cooperative_demo），再经 HTTP/MCP 验证回显、产物复制、MessagePack、合成采样与合作任务；与 Node 依赖安装验证共用启动器。

正式打包：npm run pack:cli。基础门禁：npm test；完整分发验证：npm run smoke:cli。两端还须各自执行 AGENTS.md 指定的检查，不以根 CLI 测试替代后端与前端验收。

原生插件包格式、版本和当前平台限制见 backend/docs/原生插件分发.md。插件编写只维护原有 Cargo 元数据及公开清单，便携 npm 描述由构建派生。
## 运行中安装与管理

cli-smoke-lifecycle.mjs 在真实 npx 服务启动后安装 Node 依赖插件，验证安装脚本禁用、HTTP 加载及任务执行、独立 MCP 卸载/重载、新代际和历史任务保留，由 cli-smoke.mjs 统一编排。它只验证本机当前平台包，不等于 npm registry 发布或设备层热拔插验收。

cli-smoke-devices.mjs 将公开 Node 设备示例打成 TGZ，并在同一 npx 服务默认免鉴权阶段实际安装、显式加载，经 HTTP/MCP 发现与能力调用，核对目录撤销、新代与旧引用精确拒绝、共享历史保留。此模块由 cli-smoke.mjs 编排，只证明离散 synthetic_demo，常驻连接与平台真机另外验收。

合作插件由本次测试的管理员清单配置独立 marker 目录，业务请求不接受服务器路径。每个本机地址验证 HTTP/MCP 短任务成功、长任务显式取消后的 cleaned 标记和进程退出、卸载返回时的清理完成、操作撤销、历史 cancelled 及新代际重载；服务正常关闭后核对合作清理日志落盘且没有未确认资源告警。仍使用原生 synthetic_demo，不假装连接真实设备。

根 smoke 需先由集成负责人重建当前 release runtime（宿主、插件校验器、静态前端）；运行中的原生打包步骤构建五个 release 插件并生成本次临时 tgz。测试助理仅完成脚本与语法检查，由主代理统一安排构建及 `npm run smoke:cli`。在线上传/安装服务器插件、浏览器插件及界面/逻辑扩展需要独立设计和测试，本轮脚本未覆盖这些新能力。

当前合作 demo 与原生 npx 包都按可信扩展处理。最新部署目标为本地/LAN 默认免鉴权、令牌可选。`cli-smoke.mjs` 保留显式令牌阶段的授权与缺少令牌拒绝检查，正常关闭后复用同一 tgz、临时数据、插件和公开端口，通过真正 npx 启动默认免令牌阶段，不传 `--ip` 或 `APK_API_TOKEN`。两阶段都核对默认 `0.0.0.0`；第二阶段经回环与本机局域网地址验证无 Authorization 的 HTTP/MCP 200、日志 ID 与正常关闭，使用重新监听证明两个端口均已释放。脚本覆盖不等于已运行，实际分发结果以本轮命令退出码为准；在线包上传与安装仍需独立测试。

## 真实浏览器插件验收

`node scripts/browser-plugin-smoke.mjs` 使用当前 debug 宿主；`--release` 使用当前 release 宿主。先构建前端，脚本直接向浏览器提供 `frontend/dist/assets/plugin-host.js` 的生产原字节。隐藏浏览器在独立验收页中使用公开包用例上传服务器和浏览器 TGZ，执行上传包的原生 ESM、相对模块和 JSON 资源。验收覆盖面板、组件替换、模块、命令、服务、动态注册与状态、真实任务参数钩子，以及停用后的贡献撤销、DOM 清理和宿主渲染恢复。每次重载还核对相对依赖模块图更新，最后通过前端用例清理两类部署。

浏览器驱动使用独立临时配置目录，不连接用户浏览器。可用 `DEVICEFORGE_TEST_BROWSER` 指定 Chromium 系浏览器路径；默认尝试本机 Edge/Chrome。报告写入 `artifacts/browser-plugin-smoke-<构建模式>.json`。这是框架行为验收，不是产品界面视觉、真机、跨平台或容量验收。

设备提供者第一阶段扩展后，浏览器验收另外上传独立公开 Node 示例包，再由上传浏览器插件通过 HostContext.devices 查询提供者、发现设备及提交能力任务。卸载/重载后验证目录撤销、历史保留与旧设备引用拒绝；示例明确为 synthetic_demo。当前代码须在新设备宿主和前端构建完成后运行，旧报告不证明新增范围通过。
