# 前端基础测试

`npm test` 使用 `scripts/run-tests.ts` 枚举本目录全部 `*.test.ts`，按文件名排序并最多并行启动 4 个独立 Node 22.18 以上进程。每个文件直接以 `node 文件路径` 执行，`node:test` 自动运行注册的测试并输出本文件统计；进程隔离保留，失败文件不阻止其他文件验完。入口汇总发现、执行、通过和失败文件数；任一文件非零退出、信号退出、启动失败或未执行均使正式入口非零退出，收到 SIGINT/SIGTERM 时转发给在途子进程并分别返回 130/143。

当前 Node v24.14.0 的 `node --test tests/*.test.ts` 会在架构测试的中文标准输出与二进制测试报告同批传输时触发 `FileTest.#processRawBuffer` 反序列化异常。安装版本仍使用有符号 32 位报告长度解析，与上游 [64061](https://github.com/nodejs/node/issues/64061)、[64706](https://github.com/nodejs/node/pull/64706) 和非 ASCII 输出复现 [65934](https://github.com/nodejs/node/issues/65934) 对应。正式入口直接转发各文件的文本输出，避免 Node 父子测试运行器的 V8 帧解析；不修改 Node 安装、不重试或忽略失败，也不以降低二进制运行器并发数视为根治。

维护测试、入口脚本与夹具均纳入严格 TypeScript 检查，不保留 JavaScript 副本。api 覆盖传输注入、可选鉴权、日志/错误、取消和原字节；features 覆盖晚到选择、管理取消重查和串行；runtime 覆盖 app/SDK 映射；plugin-runtime/extensions 覆盖激活与挂载回滚、独立卸载、资源逆序、跨插件服务、真实任务输入钩子及合法运行代次路径。

既有架构测试拒绝反向依赖、跨功能依赖、网络边界和动态导入绕过；生成类型仅由主代理同步。`dom-fixtures.ts` 使用 JSDOM 创建真正的类型化 DOM 节点，验证所有权和释放；网络为注入传输，外壳做 Svelte 服务端渲染。这些不是真实服务、浏览器视觉、静态包依赖执行或设备验收。

`themes.test.ts` 覆盖公开主题声明与稳定性限额、复制冻结、显式选择、变量与配色方案、可信样式节点、行内 `important` 基线精确恢复、应用失败恢复原主题、动态标识冲突、激活失败回滚、目录通知重入卸载及选择修订顺序。`theme-scope.test.ts` 覆盖面板/模块子入口与订阅撤销、兄弟和插件实例继续使用、旧代拒绝，以及即时订阅回调关闭子作用域后的释放。两文件本轮定点为 11/11，全量为 302/302；JSDOM 结果不扩大为真实浏览器或产品视觉。

独立真实浏览器主题验收使用 `scripts/browser-theme-harness.ts` 的生产构建，真实上传包经公开 `runtime.themes` 与插件上下文选择样式。2026-10-12 debug/release 均为 `report.browser.checks` 8/8，产物身份、原件摘要和具体证据边界见 [主题插件与宿主样式](../docs/主题插件与宿主样式.md)。这些是框架行为和资源生命周期验收，具体页面继续等待设计稿。
