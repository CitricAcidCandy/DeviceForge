# 根工程打包与交付工具

这里仅保存跨端交付工具，各端业务与约束仍放各自目录。

`cli-smoke-ordinary-feature.mjs` 为普通业务真实npx补充运行时功能验收，只消费本轮已安装包和合成来源。通过公开HTTP/MCP验证未知功能、同键工具排除、两个runtime模块的单快照准备、持久状态与原字节、重复准备无下载和显式移除；不代表真实SDK执行或外部发布来源通过。由 `npm run smoke:cli` 统一调用，需先重建当前运行包和插件包，旧包不包含新增贡献时明确失败。

- prepare-runtime.mjs：编译当前平台 Rust 后端/离线插件校验器，构建前端，记录程序摘要并原子生成 runtime。默认 release，--debug 用于快速开发验收。
- verify-package.mjs：npm prepack 门禁，检查版本、平台入口、摘要与静态首页。它不会下载依赖或自动编译。
- cli-smoke.mjs 与 cli-smoke-fixture.mjs：真实 tgz/npx 安装与局域网运行验证；仅操作本次临时目录和进程，不写源项目。
- native-plugin-plan.mjs：从 Cargo 与现有插件清单派生便携平台包、校对版本和选择；不复制宿主业务规则。
- native-plugin-source.mjs：优先读取正式 manifest.json，仅在不存在时兼容 manifest.example.json；收集受限公开配置模板，不采集部署者配置。
- native-plugin-package.mjs 与 pack-native-plugins.mjs：构建原生 release 插件、调用 Rust 安装门禁并生成 tgz；`npm run pack:plugins` 可按插件 ID 选择。
- cli-smoke-native.mjs：显式选择八个原生包（echo、artifact_copy、msgpack、performance_demo、cooperative_demo、settings、ai-assistant、tool-supply），通过真实 npx 安装，既有协议验证与普通业务分别执行；与 Node 依赖安装验证共用启动器。
- cli-smoke-ordinary.mjs：核对包内公开模板，在本轮隔离部署配置普通三业务，经HTTPv2/独立MCP执行配置、合成AI线程与文本ZIP安装；不连接真实模型或发布工具。两鉴权阶段共用主编排，实际结果以当次报告和退出码为准。
- cli-smoke-ordinary-failure.mjs：读取指定已通过npx报告的三原TGZ并核对摘要，独立安装后启动真实release宿主与MCP代理；在AI实际就绪后分别破坏日志头和JSON，验证helper失败仍释放门闩、CLI正常退出及原Job共享终态。只证明验收辅助的故障回收，不代表重新执行npx；所有报告、部署与脱敏证据保留，既有报告和失败目录不覆盖。

定点故障入口：`node scripts/cli-smoke-ordinary-failure.mjs <实际npx报告目录>`。默认使用系统临时短目录；追加 `--deep` 使用工作区深目录，专门复验Windows深层部署的真实配置写入。原包与当前release宿主的身份分别记录，不能将旧原包视作修后生产插件；修后深目录验收必须提供包含新插件的实际npx报告。

正式打包：npm run pack:cli。基础门禁：npm test；完整分发验证：npm run smoke:cli。两端还须各自执行 AGENTS.md 指定的检查，不以根 CLI 测试替代后端与前端验收。

原生插件包格式、版本和当前平台限制见 backend/docs/原生插件分发.md。插件编写只维护原有 Cargo 元数据及公开清单，便携 npm 描述由构建派生。
## 运行中安装与管理

cli-smoke-lifecycle.mjs 在真实 npx 服务启动后安装 Node 依赖插件，验证安装脚本禁用、HTTP 加载及任务执行、独立 MCP 卸载/重载、新代际和历史任务保留，由 cli-smoke.mjs 统一编排。它只验证本机当前平台包，不等于 npm registry 发布或设备层热拔插验收。

cli-smoke-devices.mjs 将公开 Node 设备示例打成 TGZ，并在同一 npx 服务默认免鉴权阶段实际安装、显式加载，经 HTTP/MCP 发现与能力调用，核对目录撤销、新代与旧引用精确拒绝、共享历史保留。此模块由 cli-smoke.mjs 编排，只证明离散 synthetic_demo，常驻连接与平台真机另外验收。

合作插件由本次测试的管理员清单配置独立 marker 目录，业务请求不接受服务器路径。每个本机地址验证 HTTP/MCP 短任务成功、长任务显式取消后的 cleaned 标记和进程退出、卸载返回时的清理完成、操作撤销、历史 cancelled 及新代际重载；服务正常关闭后核对合作清理日志落盘且没有未确认资源告警。仍使用原生 synthetic_demo，不假装连接真实设备。

根 smoke 需先由集成负责人重建当前 release runtime（宿主、插件校验器、静态前端）；运行中的原生打包步骤显式构建八个 release 插件并生成本次临时 tgz。脚本冻结后由主代理统一安排构建及 `npm run smoke:cli`。在线上传/安装服务器插件、浏览器插件及界面/逻辑扩展有独立验收记录，不借记本脚本覆盖。

当前合作 demo 与原生 npx 包都按可信扩展处理。最新部署目标为本地/LAN 默认免鉴权、令牌可选。`cli-smoke.mjs` 保留显式令牌阶段的授权与缺少令牌拒绝检查，正常关闭后复用同一 tgz、临时数据、插件和公开端口，通过真正 npx 启动默认免令牌阶段，不传 `--ip` 或 `APK_API_TOKEN`。两阶段都核对默认 `0.0.0.0`；第二阶段经回环与本机局域网地址验证无 Authorization 的 HTTP/MCP 200、日志 ID 与正常关闭，使用重新监听证明两个端口均已释放。脚本覆盖不等于已运行，实际分发结果以本轮命令退出码为准；在线包上传与安装仍需独立测试。

2026-10-10实际八包npx会话89135退出0，报告 `artifacts/npx-raw-fq5AVE/report.json`。两阶段各6项三业务检查/10成功Job，1007输入稳定；CLI归档26成员与缓存字节、在线host一致，八个原生原包及三业务15普通成员的离线审计保留同目录。双阶段和合成源均正常关闭并释放端口，成功临时目录清理。首轮包根假设错误的exit1报告npx-raw-6UzE03保留；主代理只修helper入口定位及公开清单物化比对后另开新轮，不改生产安装器或自动重试业务。

## 真实浏览器插件验收

`node scripts/browser-plugin-smoke.mjs` 使用当前 debug 宿主；`--release` 使用当前 release 宿主。先构建前端，脚本直接向浏览器提供 `frontend/dist/assets/plugin-host.js` 的生产原字节。隐藏浏览器在独立验收页中使用公开包用例上传服务器和浏览器 TGZ，执行上传包的原生 ESM、相对模块和 JSON 资源。验收覆盖面板、组件替换、模块、命令、服务、动态注册与状态、真实任务参数钩子，以及停用后的贡献撤销、DOM 清理和宿主渲染恢复。每次重载还核对相对依赖模块图更新，最后通过前端用例清理两类部署。

浏览器驱动使用独立临时配置目录，不连接用户浏览器。可用 `DEVICEFORGE_TEST_BROWSER` 指定 Chromium 系浏览器路径；默认尝试本机 Edge/Chrome。报告写入 `artifacts/browser-plugin-smoke-<构建模式>.json`。这是框架行为验收，不是产品界面视觉、真机、跨平台或容量验收。

报告的 `host_sha256` 与 `host_bytes` 来自实际提供给浏览器的生产宿主原字节。`browser.deviceDefinitions` 记录设备命令成功调用时观察到的提供者代际、设备 `apiVersion` 及各能力 `executionTimeoutMs`/`executionTimeoutOmitted`，不使用浏览器安装包版本推断设备契约；省略值记录为 `null`。现有 `runBrowser` 不返回实际浏览器路径/版本，`browser_runtime` 因此明确标为未记录，不把候选路径当成已选路径。此轮元数据补充的语法检查不代表已真实运行，debug/release 报告须统一门禁后更新。

设备提供者第一阶段扩展后，浏览器验收另外上传独立公开 Node 示例包，再由上传浏览器插件通过 HostContext.devices 查询提供者、发现设备及提交能力任务。卸载/重载后验证目录撤销、历史保留与旧设备引用拒绝；示例明确为 synthetic_demo。当前代码须在新设备宿主和前端构建完成后运行，旧报告不证明新增范围通过。

## 操作绑定真实验收

`node scripts/operation-alias-smoke.mjs` 运行当前 debug 宿主；release 重建后追加 `--release`。部署静态 JSON，在线安装协议 3 模拟包，验证 HTTP/MCP 单 Job、旧输入与真实目标封套、预留入口无内置回退、普通目标不能绕发现、投影失败、旧/新入口共享锁、取消、卸载排队零执行、重载新代与历史保留。职责和边界见 [操作绑定验收](operation-alias/README.md)。

cli-smoke-alias.mjs 为既有真实 npx 两阶段增加相对绑定配置路径和普通插件别名执行：同一测试 TGZ 的令牌阶段与默认免令牌阶段都经独立 MCP 端口提交，再经 HTTP 查询原名称、输入和结果。脚本新增覆盖不代表已运行，当前命令和分发摘要见根 todo。

## 统一发现与执行身份

`npm run smoke:discovery` 运行当前 debug 宿主，追加 `-- --release` 使用当前 release；`npm run smoke:discovery:browser` 验收生产前端的统一发现消费，实际结果以报告和 OS 退出码为准。夹具与 HTTP/MCP 矩阵见 [统一发现验收](unified-discovery-smoke/README.md)，三入口和 API1/2/3 不因其中一项通过就视为整批完成。

`cli-smoke-evidence.mjs` 由真实 CLI smoke 编排。打包后立即将当次实际 TGZ 字节保存到独立 `artifacts/npx-raw-*` 目录，记录摘要；两阶段分别记录独立 npm 缓存中的实际 Rust、校验器、运行清单和生产前端宿主文件，核对同一资源摘要及在线宿主字节，报告不序列化凭据、请求头或环境变量。失败保留本次临时目录与脱敏日志副本，成功才清理临时目录；真实归档副本和报告持续保留。新增脚本的静态通过不能代替实际 npx 运行。

`cli-smoke-archive.mjs` 只读当次保留 TGZ 的全部普通成员，检查头校验、重复、链接与越界后逐文件核对缓存字节数和 SHA256，并核对 npm bin 入口；不以重新打包的归档替代实际安装包。失败时先保存 `failure-before-cleanup.json`，`cli-smoke-cleanup.mjs` 再有界关闭本次宿主、记录包装进程退出与两个端口各自状态；限流退避也受关闭总等待上限约束。`node --import ./scripts/cli-smoke-controlled-failure.mjs scripts/cli-smoke.mjs` 仅在本入口第一次成功读取生产宿主正文后注入 `CliControlledFailure`，用于独立验证真实失败分支，不能把任意退出1算作注入通过。

CLI smoke 的高频行为矩阵显式使用本次 `10000` 请求/秒配置并记录到报告，生产默认不变，不构成限流容量或性能结论。统一发现辅助区分 CLI 离线部署与在线包视图：在线DELETE对离线夹具返回404；完成卸载与贡献撤销后，仅清理已校验的本轮临时离线目录，不表示生产CLI卸载命令或在线包统一管理已完成。
